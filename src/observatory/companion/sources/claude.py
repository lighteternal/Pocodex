"""Claude Code adapter: Pocodex's own hook inbox, status-line snapshot and transcript tails.

Hooks give exact turn boundaries and waits; the transcript is only read for token counts, usage-limit
refusals and, when previews are on, the question asked and the final answer. Claude Code documents its
transcript format as internal, so every transcript read is defensive and never decides turn state on its own.

Allowance comes from two places. The status line carries live percentages, but only terminal sessions
run it: the desktop app drives Claude Code headless. Any session, desktop included, logs a refusal with
the exact window and reset time when a usage limit is hit, so that window reads empty until it resets.
"""

import hashlib
import json
import os
from collections import deque
from datetime import datetime
from pathlib import Path

from observatory.companion.previews import excerpt, question_previews
from observatory.companion.sources.codex import STALE_SECONDS, timestamp

WAITS = {"permission_prompt", "elicitation_dialog", "agent_needs_input"}
WINDOWS = {"five_hour": ("5h", 300), "seven_day": ("weekly", 10080)}
USAGE_CHECK_FRESH = 900  # the opt-in usage check runs every ten minutes
TRIM_BYTES = 1024 * 1024
TAIL_BYTES = 512 * 1024


def _hashed(event: dict) -> dict:
    event["id"] = hashlib.sha256(json.dumps(event, sort_keys=True).encode()).hexdigest()[:20]
    return event


class ClaudeSource:
    app = "claude"

    def __init__(self, profile: Path, now: float):
        self.profile, self.boot = profile, now
        self.inbox, self.limits = profile / "claude-inbox.jsonl", profile / "claude-limits.json"
        self.rotated = profile / "claude-inbox.jsonl.old"
        self.offset, self.rotated_offset, self.limits_seen = 0, 0, None
        self.purge = False  # an older build stored question text: rotate that inbox out once it is read
        self.sessions: dict[str, dict] = {}
        self.attention: list[dict] = []
        self.usage: list[dict] = []
        self.responses: deque[str] = deque(maxlen=4096)
        self.quotas: dict[str, dict] = {}
        self.to_scan: set[str] = set()
        self.warnings: set[tuple] = set()
        self.previews = False
        self.error: str | None = None
        self.last_event: float | None = None

    # Inbox ---------------------------------------------------------------
    def _parse(self, data: bytes) -> list[dict]:
        lines = []
        for raw in data.splitlines():
            try:
                line = json.loads(raw)
            except ValueError:
                self.error = "Skipped an unreadable hook record"
                continue
            if isinstance(line, dict) and isinstance(line.get("at"), (int, float)) and not isinstance(line.get("at"), bool):
                lines.append(line)
                self.purge = self.purge or "questions" in line
        return lines

    def _lines(self) -> list[dict]:
        lines = []
        try:  # Rotated on an earlier poll: take what hooks appended after that read, then drop it.
            with self.rotated.open("rb") as stream:
                stream.seek(self.rotated_offset)
                data = stream.read()
            self.rotated_offset += len(data)
            lines = self._parse(data)
            self.rotated.unlink()
            self.rotated_offset = 0
        except FileNotFoundError:
            self.rotated_offset = 0
        except OSError:
            pass  # Still held open; delete it on a later poll.
        try:
            size = self.inbox.stat().st_size
        except FileNotFoundError:
            self.offset = 0
            return lines
        if size < self.offset:
            self.offset = 0
        with self.inbox.open("rb") as stream:
            stream.seek(self.offset)
            data = stream.read(4 * TRIM_BYTES)
        end = data.rfind(b"\n") + 1
        self.offset += end
        lines += self._parse(data[:end])
        if (self.offset >= TRIM_BYTES or self.purge and self.offset) and self.offset == size and not self.rotated.exists():
            try:  # Rotate, never truncate: a line appended since the read survives in the rotated file.
                os.replace(self.inbox, self.rotated)
                self.rotated_offset, self.offset, self.purge = self.offset, 0, False
            except OSError:
                pass  # On Windows a hook holding the file blocks the rename; rotate on a later poll.
        return lines

    # Transcript ----------------------------------------------------------
    def _messages(self, path: str) -> dict[str, dict]:
        """Assistant messages in the transcript tail, merged across their per-block entries."""
        try:
            with open(path, "rb") as stream:
                stream.seek(0, 2)
                start = max(0, stream.tell() - TAIL_BYTES)
                stream.seek(start)
                raw = stream.read()
        except (OSError, ValueError):
            return {}
        chunks = raw.splitlines()[1 if start else 0:]
        messages: dict[str, dict] = {}
        for chunk in chunks:
            try:
                entry = json.loads(chunk)
            except ValueError:
                continue
            message = entry.get("message") if isinstance(entry, dict) and entry.get("type") == "assistant" else None
            if not isinstance(message, dict) or not isinstance(message.get("id"), str):
                continue
            merged = messages.setdefault(message["id"], {"texts": [], "usage": None, "model": "claude", "at": 0})
            merged["at"] = timestamp(entry.get("timestamp"))
            merged["model"] = str(message.get("model", merged["model"]))[:100]
            if isinstance(message.get("usage"), dict):
                merged["usage"] = message["usage"]
            for block in message.get("content", []) if isinstance(message.get("content"), list) else []:
                if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str):
                    merged["texts"].append(block["text"])
        return messages

    def _record_answer(self, session: dict, event: dict) -> None:
        messages = self._messages(session["transcript"])
        for ident, message in messages.items():
            usage = message["usage"]
            if ident in self.responses or not usage or message["at"] < self.boot:
                continue
            self.responses.append(ident)
            count = lambda key: usage[key] if isinstance(usage.get(key), int) and not isinstance(usage.get(key), bool) and usage[key] >= 0 else 0
            cached = count("cache_read_input_tokens")
            prompt = count("input_tokens") + count("cache_creation_input_tokens") + cached
            output = count("output_tokens")
            self.usage.append({"at": message["at"], "app": "claude", "thread": session["id"], "project": session["project"],
                               "model": message["model"], "input": prompt, "cached": cached, "output": output,
                               "reasoning": 0, "total": prompt + output})
        self.usage = self.usage[-500:]
        if self.previews and messages:
            text = "\n".join(list(messages.values())[-1]["texts"]).strip()
            if text:
                event["preview"] = excerpt(text)

    # State machine -------------------------------------------------------
    @staticmethod
    def _size(path: str) -> int | None:
        try:
            return Path(path).stat().st_size if path else None
        except (OSError, ValueError):
            return None

    def _event(self, kind: str, session: dict, at: float, **extra) -> dict:
        return _hashed({"kind": kind, "app": "claude", "thread": session["id"], "turn": session["turn"],
                        "turn_key": f"claude:{session['id']}", "project": session["project"], "at": at, **extra})

    def _apply(self, line: dict) -> list[dict]:
        at, name = float(line["at"]), line.get("event")
        ident = str(line.get("session", ""))[:100]
        if not ident:
            return []
        live = at >= self.boot
        if live:
            self.last_event = max(self.last_event or 0, at)
        session = self.sessions.setdefault(ident, {"id": ident, "status": "idle", "turn": 0, "last_seen": at, "wait": None,
                                                   "project": "", "transcript": "", "size": None, "wait_size": None})
        session["project"] = str(line.get("project") or session["project"])[:100]
        session["transcript"] = str(line.get("transcript") or session["transcript"])
        busy = session["status"] in ("working", "waiting")
        events = []
        if name == "UserPromptSubmit":
            session.update(status="working", turn=session["turn"] + 1, wait=None, last_seen=at, size=self._size(session["transcript"]))
        elif name == "PreToolUse" and line.get("tool") == "AskUserQuestion" and busy:
            session.update(status="waiting", wait="question", last_seen=at, ask=str(line.get("tool_use") or ""), asked=None)
            events.append(self._event("input_needed", session, at, reason="question"))
        elif name == "PostToolUse" and line.get("tool") == "AskUserQuestion" and session["status"] == "waiting":
            session.update(status="working", wait=None, last_seen=at)
        elif name == "Notification" and line.get("notification") in WAITS and busy:
            session.update(status="waiting", wait="permission", last_seen=at, wait_size=self._size(session["transcript"]))
            events.append(self._event("input_needed", session, at, reason="permission"))
        elif name == "Stop" and busy:
            session.update(status="completed", wait=None, last_seen=at)
            event = self._event("completed", session, at)
            if live:
                self._record_answer(session, event)
            events.append(event)
        elif name in ("StopFailure", "SessionEnd") and busy:
            session.update(status="stopped", wait=None, last_seen=at)
            events.append(self._event("stopped", session, at))
        elif name == "SessionEnd":
            session["status"] = "ended" if session["status"] in ("completed", "stopped") else "idle"
        if name in ("Stop", "StopFailure"):
            self.to_scan.add(ident)  # a turn that ends may have ended on a usage limit
        return events if live else []

    def _heartbeats(self, now: float) -> None:
        """A growing transcript keeps a long turn alive and shows an approved permission ran."""
        for session in self.sessions.values():
            if session["status"] not in ("working", "waiting"):
                continue
            size = self._size(session["transcript"])
            if size is None or size == session["size"]:
                continue
            session.update(size=size, last_seen=now)
            if session["wait"] == "permission" and size != session["wait_size"]:
                session.update(status="working", wait=None)

    @staticmethod
    def _asked(path: str, tool_use: str, at: float) -> list[dict] | None:
        """The questions of this AskUserQuestion call, from the transcript tail; None until it is written."""
        try:
            with open(path, "rb") as stream:
                stream.seek(0, 2)
                stream.seek(max(0, stream.tell() - TAIL_BYTES))
                raw = stream.read()
        except (OSError, ValueError):
            return None
        found = None
        for chunk in raw.splitlines():
            if b'"AskUserQuestion"' not in chunk:
                continue
            try:
                entry = json.loads(chunk)
            except ValueError:
                continue
            message = entry.get("message") if isinstance(entry, dict) and entry.get("type") == "assistant" else None
            for block in message.get("content", []) if isinstance(message, dict) and isinstance(message.get("content"), list) else []:
                # Without a tool use id (older Claude Code), only a call written just before the hook ran.
                if (isinstance(block, dict) and block.get("type") == "tool_use" and block.get("name") == "AskUserQuestion"
                        and isinstance(block.get("input"), dict)
                        and (block.get("id") == tool_use if tool_use else timestamp(entry.get("timestamp")) >= at - 30)):
                    values = block["input"].get("questions")
                    found = question_previews([q for q in values[:32] if isinstance(q, dict)]) if isinstance(values, list) else []
        return found

    def _fill_questions(self) -> None:
        """Question text is never stored: read it from the transcript, again whenever that grows until it appears."""
        for event in self.attention:
            session = self.sessions.get(event.get("thread"))
            if event["kind"] != "input_needed" or event.get("reason") != "question" or "questions" in event or not session:
                continue
            size = self._size(session["transcript"])
            if size is None or size == session.get("asked"):
                continue
            session["asked"] = size
            found = self._asked(session["transcript"], session.get("ask", ""), event["at"])
            if found is not None:
                event["questions"] = found

    # Allowance -----------------------------------------------------------
    @staticmethod
    def _refusals(path: str) -> list[tuple[str, float, float]]:
        """Usage-limit refusals in the transcript tail: (window, reset, when)."""
        try:
            with open(path, "rb") as stream:
                stream.seek(0, 2)
                stream.seek(max(0, stream.tell() - TAIL_BYTES))
                raw = stream.read()
        except (OSError, ValueError):
            return []
        found = []
        for chunk in raw.splitlines():
            if b'"quotaLimits"' not in chunk:
                continue
            try:
                entry = json.loads(chunk)
            except ValueError:
                continue
            limit = entry.get("quotaLimits") if isinstance(entry, dict) else None
            reset = limit.get("resetsAt") if isinstance(limit, dict) else None
            if (isinstance(limit, dict) and limit.get("status") == "rejected" and limit.get("rateLimitType") in WINDOWS
                    and isinstance(reset, (int, float)) and not isinstance(reset, bool)):
                found.append((limit["rateLimitType"], float(reset), timestamp(entry.get("timestamp"))))
        return found

    def _read_refusals(self, now: float) -> list[dict]:
        events = []
        for ident in self.to_scan:
            session = self.sessions.get(ident)
            for name, reset, at in self._refusals(session["transcript"]) if session else []:
                label, minutes = WINDOWS[name]
                key = f"claude:{label}"
                known = self.quotas.get(key)
                if reset <= now or (known and known["at"] > at):
                    continue
                self.quotas[key] = {"key": key, "app": "claude", "bucket": "Claude", "window": label, "label": label,
                                    "minutes": minutes, "remaining": 0, "resets_at": reset, "at": at, "fresh_until": reset,
                                    "account": "Claude Code", "source": "Claude Code usage limit"}
                if (key, reset, 0) not in self.warnings:
                    self.warnings.add((key, reset, 0))
                    if at >= self.boot:  # a limit hit before launch is shown, not announced
                        events.append(_hashed({"kind": "limit_reached", "app": "claude", "remaining": 0, "window": label, "at": at}))
        self.to_scan.clear()
        return events

    def _read_limits(self, now: float) -> list[dict]:
        try:
            stamp = self.limits.stat().st_mtime_ns
        except FileNotFoundError:
            return []
        if stamp == self.limits_seen:
            return []
        self.limits_seen = stamp
        try:
            saved = json.loads(self.limits.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        at = saved.get("at") if isinstance(saved, dict) else None
        limits = saved.get("rate_limits") if isinstance(saved, dict) else None
        if not isinstance(at, (int, float)) or not isinstance(limits, dict):
            return []
        checked = saved.get("source") == "usage_check"
        events = []
        for name, (label, minutes) in WINDOWS.items():
            raw = limits.get(name)
            used = raw.get("used_percentage") if isinstance(raw, dict) else None
            if not isinstance(used, (int, float)) or isinstance(used, bool):
                continue
            remaining = max(0, min(100, round(100 - used)))
            reset = raw.get("resets_at")
            key = f"claude:{label}"
            self.quotas[key] = {"key": key, "app": "claude", "bucket": "Claude", "window": label, "label": label,
                                "minutes": minutes, "remaining": remaining, "resets_at": reset, "at": at,
                                "fresh_until": at + (USAGE_CHECK_FRESH if checked else STALE_SECONDS), "account": "Claude Code",
                                "source": "Claude Code usage check" if checked else "Claude Code status line"}
            threshold = next((t for t in (0, 10, 20) if remaining <= t), None)
            fresh = now <= self.quotas[key]["fresh_until"] and isinstance(reset, (int, float)) and reset > now
            if fresh and threshold is not None and (key, reset, threshold) not in self.warnings:
                self.warnings.add((key, reset, threshold))
                events.append(_hashed({"kind": "limit_reached" if threshold == 0 else "low_allowance", "app": "claude",
                                       "remaining": remaining, "window": label, "at": at}))
        return events

    # Adapter contract ----------------------------------------------------
    def _relevant(self, event: dict) -> bool:
        session = self.sessions.get(event.get("thread"))
        if event["kind"] in ("completed", "stopped"):
            return bool(session and session["turn"] == event["turn"] and session["status"] in (event["kind"], "ended"))
        if event["kind"] == "input_needed":
            return bool(session and session["turn"] == event["turn"] and session["status"] == "waiting" and session["wait"] == event["reason"])
        return True

    def poll(self, now: float) -> list[dict]:
        events = [event for line in self._lines() for event in self._apply(line)]
        self._heartbeats(now)
        events.extend(self._read_limits(now))
        events.extend(self._read_refusals(now))
        events = [e for e in events if self._relevant(e)]
        self.attention = [e for e in self.attention + events if self._relevant(e)][-100:]
        if self.previews:
            self._fill_questions()
        return events

    def acknowledge(self, ident: str) -> None:
        self.attention = [e for e in self.attention if e["id"] != ident]

    def set_previews(self, enabled: bool) -> None:
        self.previews = enabled
        if not enabled:
            for event in self.attention:
                event.pop("preview", None)
                event.pop("questions", None)
            for session in self.sessions.values():
                session["asked"] = None  # turned back on, a waiting question is read again

    def snapshot(self, now: float) -> dict:
        live = [s for s in self.sessions.values() if s["status"] in ("working", "waiting")]
        running = sum(s["status"] == "working" and now - s["last_seen"] <= STALE_SECONDS for s in live)
        waiting = sum(s["status"] == "waiting" for s in live)
        uncertain = sum(s["status"] == "working" and now - s["last_seen"] > STALE_SECONDS for s in live)
        # A refusal holds until its reset and then means nothing; a reading goes stale after a while.
        self.quotas = {k: q for k, q in self.quotas.items() if q["source"] != "Claude Code usage limit" or q["resets_at"] > now}
        quota = [{**q, "stale": now > q["fresh_until"] or not isinstance(q["resets_at"], (int, float)) or q["resets_at"] <= now}
                 for q in self.quotas.values()]
        today = datetime.fromtimestamp(now).date()
        usage = [u for u in self.usage if datetime.fromtimestamp(u["at"]).date() == today]
        return {"running": running, "waiting": waiting, "uncertain": uncertain,
                "activity": "waiting" if waiting else "working" if running else "unknown" if uncertain else "idle",
                "quota": sorted(quota, key=lambda q: (q["stale"], q["remaining"])),
                "tokens": sum(u["total"] for u in usage), "cached": sum(u["cached"] for u in usage),
                "input": sum(u["input"] for u in usage), "output": sum(u["output"] for u in usage),
                "usage": usage[-200:], "attention": self.attention,
                "sources": [{"path": "Claude Code hooks", "status": self.error or "Listening for Claude Code"}]}
