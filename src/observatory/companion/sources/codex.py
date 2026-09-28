"""Codex adapter: bounded session-log tails with optional in-memory answer/question excerpts."""

import hashlib
import json
import math
from collections import deque
from datetime import datetime
from pathlib import Path

from observatory.companion.metadata import counter_values, local_project
from observatory.companion.previews import answered_questions, excerpt, question_previews, questions, user_text


MAX_LINE = 8 * 1024 * 1024
STALE_SECONDS = 120
WINDOW_LABELS = {300: "5h", 10080: "weekly"}


def timestamp(value: object) -> float:
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (ValueError, OverflowError):
        return 0


class Sources:
    """Observe without creating Codex sessions or assuming a different CLI account."""

    app = "codex"

    def __init__(self, roots: list[Path], now: float):
        self.roots = roots
        self.boot = now
        self.paths: dict[Path, dict] = {}
        self.observed_sizes: dict[Path, int] = {}
        self.turns: dict[str, dict] = {}
        self.quotas: dict[str, dict] = {}
        self.warnings: set[tuple] = set()
        self.responses: set[str] = set()
        self.finished: deque[tuple] = deque(maxlen=512)
        self.usage: list[dict] = []
        self.attention: list[dict] = []
        self.previews = False
        self.pending_questions: dict[tuple, set[int]] = {}
        self.seen_questions: deque[tuple] = deque(maxlen=512)
        self.errors: dict[str, str] = {}
        self.last_inventory = 0
        self.last_event: float | None = None
        self._inventory(now)

    def _inventory(self, now: float) -> None:
        for root in self.roots:
            label = str(root)
            if not (root / "sessions").is_dir():
                self.errors[label] = "Source folder unavailable"
                continue
            self.errors.pop(label, None)
            try:
                for path in (root / "sessions").rglob("*.jsonl"):
                    stat = path.stat()
                    previous_size = self.observed_sizes.get(path)
                    self.observed_sizes[path] = stat.st_size
                    # Windows can defer mtime changes while Codex holds its log open.
                    grew = previous_size is not None and stat.st_size != previous_size
                    if path not in self.paths and (stat.st_mtime >= self.boot - 86400 or grew):
                        self.paths[path] = {"offset": 0, "thread": None, "turn": "unknown", "project": "", "source": label}
            except OSError:
                self.errors[label] = "Cannot enumerate this source"
        self.last_inventory = now

    def poll(self, now: float) -> list[dict]:
        if now - self.last_inventory >= 5:
            self._inventory(now)
        events = []
        for path, ctx in list(self.paths.items()):
            try:
                stat = path.stat()
                size = stat.st_size
                identity = (stat.st_dev, stat.st_ino)
                if ("identity" in ctx and identity != ctx["identity"]) or size < ctx["offset"]:
                    self._forget(ctx)
                    source = ctx["source"]
                    ctx.clear()
                    ctx.update(offset=0, thread=None, turn="unknown", project="", source=source)
                ctx["identity"] = identity
                if size == ctx["offset"]:
                    continue
                with path.open("rb") as stream:
                    stream.seek(ctx["offset"])
                    budget = 12 * 1024 * 1024
                    while budget > 0:
                        line = stream.readline(MAX_LINE + 1)
                        budget -= len(line)
                        if ctx.get("discard") or len(line) > MAX_LINE:
                            while line and not line.endswith(b"\n") and budget > 0:
                                line = stream.readline(min(MAX_LINE + 1, budget))
                                budget -= len(line)
                            ctx["discard"] = bool(line and not line.endswith(b"\n"))
                            ctx["offset"] = stream.tell()
                            ctx["error"] = "Oversized event record skipped"
                            continue
                        if not line or not line.endswith(b"\n"):
                            break
                        ctx["offset"] = stream.tell()
                        try:
                            record = json.loads(line)
                            events.extend(self._consume(record, ctx, now))
                        except (ValueError, TypeError, KeyError, AttributeError, OverflowError):
                            ctx["error"] = "Unsupported event record; update Pocodex"
            except FileNotFoundError:
                self._forget(ctx)
                del self.paths[path]
                self.observed_sizes.pop(path, None)
            except OSError:
                self.errors[ctx["source"]] = "Source disconnected or unreadable"
        def still_relevant(event: dict) -> bool:
            if event.get("asynchronous"):
                return (event["turn_key"], event["call_id"]) in self.pending_questions
            if event["kind"] in {"completed", "stopped"}:
                turn = self.turns.get(event["turn_key"])
                return bool(turn and turn["turn"] == event["turn"] and turn["status"] == event["kind"])
            if event["kind"] != "input_needed":
                return True
            turn = self.turns.get(event["turn_key"])
            return bool(turn and turn["status"] == "waiting" and turn["wait_call"] == event["call_id"])

        events = [event for event in events if still_relevant(event)]
        self.attention = [event for event in self.attention + events if still_relevant(event)][-100:]
        return events

    def _forget(self, ctx: dict) -> None:
        """A removed/replaced log must not keep its old running or waiting state."""
        old_key = ctx["source"] + ":" + str(ctx["thread"])
        self.turns.pop(old_key, None)
        self.attention = [e for e in self.attention if e.get("turn_key") != old_key]
        for key in list(self.pending_questions):
            if key[0] == old_key:
                del self.pending_questions[key]

    def _consume(self, record: dict, ctx: dict, now: float) -> list[dict]:
        payload = record.get("payload", {})
        kind = record.get("type")
        at = timestamp(record.get("timestamp"))
        if not isinstance(payload, dict):
            ctx["error"] = "Unsupported event payload; update Pocodex"
            return []
        if kind == "session_meta":
            origin = str(payload.get("originator", "")).lower().replace(" ", "_")
            if origin in {"codex_desktop", "codex_work_desktop", "codex_cli_rs", "codex_vscode", "codex_exec"}:
                ctx["thread"] = payload.get("id")
                ctx["project"] = local_project(str(payload.get("cwd", "")))[:100]
            else:
                ctx["thread"] = None
                ctx["error"] = "Unrecognized session origin; update Pocodex"
            return []
        if not ctx["thread"]:
            return []
        if kind == "turn_context":
            ctx["turn"] = payload.get("turn_id", ctx["turn"])
            ctx["model"] = str(payload.get("model", "unknown"))[:100]
            return []
        # Retained history is not a live signal. Do not retrospectively notify or award XP.
        if at < self.boot or at > now + 10:
            return []
        self.last_event = max(self.last_event or 0, at)
        thread = ctx["thread"]
        key = ctx["source"] + ":" + thread
        turn = self.turns.get(key)
        name = payload.get("type")
        tool = str(payload.get("name", "")).split(".")[-1]
        is_question = kind == "response_item" and name in {"function_call", "custom_tool_call"} and tool in {"request_user_input", "request_user_input_async"}
        replies = answered_questions(payload)
        for call_id, index in replies:
            pending_key = (key, call_id)
            if pending_key in self.pending_questions:
                self.pending_questions[pending_key].discard(index)
                if not self.pending_questions[pending_key]:
                    del self.pending_questions[pending_key]
        if not replies and user_text(payload) is not None:
            # A typed answer instead of the question card still means the Trainer has seen this chat's questions.
            for pending_key in [k for k in self.pending_questions if k[0] == key]:
                del self.pending_questions[pending_key]
        is_terminal = kind == "event_msg" and name in {"task_complete", "task_interrupted", "turn_aborted"}
        if (turn is None and (is_question or is_terminal)) or (is_question and turn and turn["status"] in {"completed", "stopped"}):
            ctx["turn"] = payload.get("turn_id", ctx["turn"])
            turn = {"thread": thread, "turn": ctx["turn"], "status": "working", "last_seen": at,
                    "project": ctx["project"], "source": ctx["source"], "wait_call": None}
            self.turns[key] = turn
        if turn is None and ctx["turn"] != "unknown" and (kind == "token_usage_record" or (kind == "event_msg" and name == "token_count")):
            turn = {"thread": thread, "turn": ctx["turn"], "status": "working", "last_seen": at,
                    "project": ctx["project"], "source": ctx["source"], "wait_call": None}
            self.turns[key] = turn
        event = None
        if kind == "event_msg" and name == "task_started":
            ctx["turn"] = payload.get("turn_id", ctx["turn"])
            self.turns[key] = {"thread": thread, "turn": ctx["turn"], "status": "working", "last_seen": at,
                               "project": ctx["project"], "source": ctx["source"], "wait_call": None}
        elif is_terminal:
            turn_id = payload.get("turn_id", ctx["turn"])
            if turn and turn["turn"] != turn_id and turn["status"] in {"working", "waiting"}:
                return []
            finished_key = (key, turn_id, name)
            if finished_key not in self.finished:
                self.finished.append(finished_key)
                status = "completed" if name == "task_complete" else "stopped"
                if turn:
                    turn.update(status=status, turn=turn_id)
                event = {"kind": status, "thread": thread, "turn": turn_id, "turn_key": key, "project": ctx["project"], "at": at}
                if self.previews and status == "completed":
                    event["preview"] = excerpt(payload.get("last_agent_message"))
        elif is_question:
            question_key = (key, payload.get("call_id"))
            if turn and question_key not in self.seen_questions:
                self.seen_questions.append(question_key)
                asynchronous = tool == "request_user_input_async"
                values = questions(payload)
                if asynchronous:
                    self.pending_questions[question_key] = set(range(max(1, len(values))))
                    while len(self.pending_questions) > 100:
                        del self.pending_questions[next(iter(self.pending_questions))]
                else:
                    turn.update(status="waiting", wait_call=payload.get("call_id"), last_seen=at)
                event = {"kind": "input_needed", "thread": thread, "project": ctx["project"], "at": at,
                         "turn_key": key, "call_id": payload.get("call_id"), "asynchronous": asynchronous}
                if self.previews:
                    event["questions"] = question_previews(values)
        elif kind == "response_item" and name in {"function_call_output", "custom_tool_call_output"}:
            if turn and turn["status"] == "waiting" and payload.get("call_id") == turn["wait_call"]:
                turn.update(status="working", wait_call=None, last_seen=at)
        if turn and turn["status"] == "working":
            turn["last_seen"] = at
        if kind == "token_usage_record":
            response = payload.get("response_id")
            values = counter_values(payload.get("usage", {}))
            if response and values and payload.get("thread_id") == thread and response not in self.responses:
                self.responses.add(response)
                self.usage.append({"at": at, "thread": thread, "project": ctx["project"], "model": ctx.get("model", "unknown"),
                                   "input": values[0], "cached": values[1], "output": values[3], "reasoning": values[4], "total": values[0] + values[3]})
        events = [event] if event else []
        if kind == "event_msg" and name == "token_count" and isinstance(payload.get("rate_limits"), dict):
            limits = payload["rate_limits"]
            for window in ("primary", "secondary"):
                raw = limits.get(window)
                if not isinstance(raw, dict):
                    continue
                used = raw.get("used_percent")
                if not isinstance(used, (int, float)) or isinstance(used, bool) or not math.isfinite(used):
                    continue
                remaining = max(0, min(100, 100 - used))
                bucket = str(limits.get("limit_id", "codex"))[:100]
                quota_key = f"{ctx['source']}:{bucket}:{window}"
                reset = raw.get("resets_at")
                minutes = raw.get("window_minutes")
                quota = {"key": quota_key, "app": "codex", "label": WINDOW_LABELS.get(minutes) or (f"{minutes} min" if minutes else window),
                         "bucket": bucket, "window": window, "remaining": remaining,
                         "minutes": raw.get("window_minutes"), "resets_at": reset, "at": at,
                         "account": "Account identity unavailable", "source": "Local Codex record"}
                self.quotas[quota_key] = quota
                threshold = next((t for t in (0, 10, 20) if remaining <= t), None)
                warning_key = (quota_key, reset, threshold)
                fresh = now - at <= STALE_SECONDS and isinstance(reset, (int, float)) and reset > now
                if fresh and threshold is not None and warning_key not in self.warnings:
                    self.warnings.add(warning_key)
                    events.append({"kind": "limit_reached" if threshold == 0 else "low_allowance", "remaining": remaining,
                                   "window": window, "at": at, "thread": thread})
        for item in events:
            item["app"] = "codex"
            item["id"] = hashlib.sha256(json.dumps(item, sort_keys=True).encode()).hexdigest()[:20]
        return events

    def acknowledge(self, ident: str) -> None:
        self.attention = [e for e in self.attention if e["id"] != ident]

    def set_previews(self, enabled: bool) -> None:
        self.previews = enabled
        if not enabled:
            for event in self.attention:
                event.pop("preview", None)
                event.pop("questions", None)

    def snapshot(self, now: float) -> dict:
        errors = {ctx["source"]: ctx["error"] for ctx in self.paths.values() if ctx.get("error")}
        errors.update(self.errors)
        running = sum(t["status"] == "working" and now - t["last_seen"] <= STALE_SECONDS for t in self.turns.values())
        waiting = sum(t["status"] == "waiting" for t in self.turns.values())
        uncertain = sum(t["status"] == "working" and now - t["last_seen"] > STALE_SECONDS for t in self.turns.values())
        quota = [{**q, "stale": now - q["at"] > STALE_SECONDS or not isinstance(q["resets_at"], (float, int)) or q["resets_at"] <= now} for q in self.quotas.values()]
        usage = [u for u in self.usage if datetime.fromtimestamp(u["at"]).date() == datetime.fromtimestamp(now).date()]
        return {"running": running, "waiting": waiting, "uncertain": uncertain,
                "activity": "waiting" if waiting else "working" if running else "unknown" if uncertain or errors else "idle",
                "quota": sorted(quota, key=lambda q: (q["stale"], q["remaining"])),
                "tokens": sum(u["total"] for u in usage), "cached": sum(u["cached"] for u in usage),
                "input": sum(u["input"] for u in usage), "output": sum(u["output"] for u in usage),
                "usage": usage[-200:], "attention": self.attention,
                "sources": [{"path": str(root), "status": errors.get(str(root), "Reading local metadata")} for root in self.roots],
                "coverage": "Since companion launch; local records only",
                "capabilities": {"completion": True, "input_requests": True, "native_approvals": False,
                                 "quota": "observed snapshots", "time": "observed running time; 120-second silence cutoff"}}
