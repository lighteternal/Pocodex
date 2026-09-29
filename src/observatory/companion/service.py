"""Private newline-JSON desktop sidecar. Never opens a network listener."""

import argparse
import bisect
import json
import os
import queue
import sys
import threading
import time
import traceback
from datetime import datetime
from pathlib import Path

from observatory.companion import claude_settings, claude_usage
from observatory.companion.detect import detect
from observatory.companion.engine import THRESHOLDS, Companion
from observatory.companion.sources import ClaudeSource, Sources
from observatory.companion.telemetry import Telemetry


def send(message: dict) -> None:
    print(json.dumps(message, ensure_ascii=True, allow_nan=False), flush=True)


def source_roots(profile: Path, explicit: list[Path] | None = None) -> list[Path]:
    """Use the user data location, never the versioned Codex application package."""
    if explicit:
        return list(dict.fromkeys(p.expanduser().resolve() for p in explicit))
    configured = os.environ.get("CODEX_HOME", "").strip()
    default = Path(configured).expanduser() if configured else Path.home() / ".codex"
    saved = profile / "sources.json"
    paths = json.loads(saved.read_text(encoding="utf-8")) if saved.exists() else []
    if not isinstance(paths, list) or any(not isinstance(p, str) for p in paths):
        raise ValueError("Saved source list is invalid; restore sources.json from your backup")
    return list(dict.fromkeys(p.expanduser().resolve() for p in [default, *map(Path, paths)]))


def hook_command(raw: str | None) -> list[str] | None:
    """How Claude Code should launch Pocodex's hook: a JSON list of strings from the desktop shell."""
    if not raw:
        return None
    value = json.loads(raw)
    if not isinstance(value, list) or not value or not all(isinstance(part, str) and part for part in value):
        raise ValueError("--hook-command must be a JSON list of strings")
    return value


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--source", type=Path, action="append")
    parser.add_argument("--claude-config", type=Path)
    parser.add_argument("--hook-command")
    parser.add_argument("--claude-cli", help="Claude Code CLI for the usage check; with --claude-config, the only one used")
    args = parser.parse_args()
    catalog = json.loads((args.assets / "catalog.json").read_text(encoding="utf-8"))
    roots_file = args.data / "sources.json"
    roots = source_roots(args.data, args.source)
    hook = hook_command(args.hook_command)
    claude_dir = claude_settings.config_dir(args.claude_config)
    now = time.time()
    battle_file = args.assets / "battle.json"
    battle_data = json.loads(battle_file.read_text(encoding="utf-8")) if battle_file.exists() else None
    engine = Companion(args.data / "companion.sqlite", catalog, now, battle_data=battle_data)

    def setting(name: str):
        # Read through the engine every time: a failed command rolls engine.state back to a copy.
        return engine.state["settings"][name]

    adapters = {}
    if setting("codex"):
        adapters["codex"] = Sources(roots, now)
    if setting("claude"):
        adapters["claude"] = ClaudeSource(args.data, now)
    telemetry = Telemetry(adapters)
    telemetry.set_previews(setting("message_previews"))
    found = detect(roots[0] if roots else None, claude_dir, isolated=args.claude_config is not None)
    claude_problem = {"error": None, "snippet": None}
    # An isolated run (tests, sandboxes) never starts the Trainer's real Claude Code.
    usage_cli = args.claude_cli or (None if args.claude_config is not None else claude_usage.find_cli())
    usage = {"thread": None, "next": 0.0, "problem": None, "at": None, "stop": threading.Event()}

    def usage_check() -> None:
        try:
            if not usage_cli:
                raise claude_usage.UsageCheckError("Claude Code isn't installed on Windows. Install it and sign in to use the check.")
            limits = claude_usage.check(usage_cli, args.data / "claude-usage-check", wait=usage["stop"].wait)
            target = args.data / "claude-limits.json"
            temporary = target.with_suffix(".tmp")
            temporary.write_text(json.dumps({"at": time.time(), "rate_limits": limits, "source": "usage_check"}), encoding="utf-8")
            os.replace(temporary, target)
            usage.update(problem=None, at=time.time())
        except claude_usage.UsageCheckError as error:
            usage["problem"] = str(error)
        except OSError:
            usage["problem"] = "Couldn't save Claude's usage in Pocodex's folder."
        finally:
            usage["next"] = time.time() + claude_usage.EVERY_SECONDS
    published: dict = {}

    def claude_status() -> dict:
        if not hook:
            return {"readable": True, "connected": False, "current": False, "status_line": False}
        return claude_settings.status(claude_dir, hook, args.data)

    status_cache = claude_status()
    if setting("claude") and hook and status_cache["readable"] and not status_cache["current"]:
        try:  # Pocodex moved or was updated: rewrite only its own entries.
            status_cache = claude_settings.connect(claude_dir, hook, args.data)
        except (OSError, claude_settings.SettingsUnreadable):
            pass

    def connections() -> dict:
        return {"codex": {"enabled": setting("codex"), **found["codex"]},
                "claude": {"enabled": setting("claude"), **found["claude"], **status_cache, **claude_problem,
                           "can_connect": bool(hook),
                           "usage_check": {"enabled": setting("claude_usage_check"), "problem": usage["problem"], "at": usage["at"],
                                           "checking": bool(usage["thread"] and usage["thread"].is_alive())}}}

    def connect(app: str, enabled: bool) -> None:
        nonlocal status_cache
        if app == "claude":
            if not hook:
                raise ValueError("This build of Pocodex cannot connect Claude Code")
            claude_problem.update(error=None, snippet=None)
            try:
                status_cache = (claude_settings.connect(claude_dir, hook, args.data) if enabled
                                else claude_settings.disconnect(claude_dir, args.data))
            except claude_settings.SettingsUnreadable as error:
                claude_problem.update(error="unreadable", snippet=claude_settings.snippet(hook, args.data))
                raise ValueError("Couldn't read your Claude Code settings, so Pocodex left them unchanged. Settings > Connections shows how to connect by hand.") from error
        if enabled:
            telemetry.adapters[app] = Sources(roots, time.time()) if app == "codex" else ClaudeSource(args.data, time.time())
            telemetry.set_previews(setting("message_previews"))
        else:
            telemetry.adapters.pop(app, None)
        engine.command("settings", {app: enabled})

    def write_json(name: str, value: dict) -> None:
        try:
            (args.data / name).write_text(json.dumps(value), encoding="utf-8")
        except OSError:
            pass

    def publish_files() -> None:
        """Small files the Claude hook and status line read: who the buddy is, and whether previews are on."""
        active = engine._active()
        buddy = ({"name": engine.catalog[active["species_id"]]["name"], "level": min(100, bisect.bisect_right(THRESHOLDS, active["xp"]))}
                 if active else {"name": "Egg", "level": None})
        if buddy != published.get("buddy"):
            write_json("buddy-status.json", buddy)
            published["buddy"] = buddy
        flags = {"previews": bool(setting("message_previews"))}
        if flags != published.get("hook"):
            write_json("claude-hook.json", flags)
            published["hook"] = flags

    commands: queue.Queue = queue.Queue()

    def read_commands() -> None:
        while line := sys.stdin.readline(65537):
            try:
                if len(line) > 65536:
                    raise ValueError("Command exceeds 64 KB")
                message = json.loads(line)
                if not isinstance(message, dict):
                    raise ValueError("Command must be an object")
                commands.put(message)
            except ValueError:
                commands.put({"id": None, "action": "invalid"})
        commands.put({"action": "quit"})

    threading.Thread(target=read_commands, daemon=True).start()
    previous = now
    was_running: dict[str, bool] = {}
    cached_key = None
    cached_profile = None

    def snapshot(at: float, observed: dict | None = None) -> dict:
        nonlocal cached_key, cached_profile
        day = datetime.fromtimestamp(at).date().isoformat()
        if cached_key != (engine.state["revision"], day):  # battles_left comes back at local midnight, unsaved
            cached_profile = engine.snapshot()
            cached_key = (engine.state["revision"], day)
        result = dict(cached_profile)
        result["treats"] = engine.treats(at)
        result["telemetry"] = observed or telemetry.snapshot(at)
        result["connections"] = connections()
        result["today_seconds"] = result["daily"].get(day, {}).get("seconds", 0)
        result["now"] = at
        return result

    def emit(message: dict) -> None:
        publish_files()
        send(message)

    emit({"type": "state", "state": snapshot(now)})
    last_emitted = now
    emitted_signature = None
    try:
        while True:
            now = time.time()
            events = telemetry.poll(now)
            observed = telemetry.snapshot(now)
            running = {app: info["running"] > 0 for app, info in observed["apps"].items() if info["connected"]}
            # Each app earns for its own confirmed time; never bridge sleep, stalls or an unseen start.
            for app, busy in running.items():
                if was_running.get(app) and busy and 0 < now - previous <= 5:
                    engine.credit(previous, now, app)
            if not any(running.values()):
                engine.observe_rest(now)
            care_events = engine.care_events(now)
            engine.record_answers(sum(event["kind"] == "completed" for event in events))
            telemetry.add_attention(care_events)
            # Level-ups are reactions, not alerts: they never enter the Pokegear queue.
            events.extend(care_events + engine.drain_events())
            previous, was_running = now, running
            if not setting("claude_usage_check"):
                usage.update(next=0.0, problem=None)  # turning it on checks straight away
            elif setting("claude") and now >= usage["next"] and not (usage["thread"] and usage["thread"].is_alive()):
                usage["next"] = now + claude_usage.EVERY_SECONDS
                usage["thread"] = threading.Thread(target=usage_check, name="claude-usage", daemon=True)
                usage["thread"].start()
            changed = False
            while True:
                try:
                    message = commands.get_nowait()
                except queue.Empty:
                    break
                action = message.get("action")
                if action == "quit":
                    return
                try:
                    payload = message.get("args", {})
                    if not isinstance(payload, dict):
                        raise ValueError("Action arguments must be an object")
                    if action == "acknowledge":
                        telemetry.acknowledge(str(payload.get("id", "")))
                    elif action == "connect":
                        if payload.get("app") not in ("codex", "claude") or not isinstance(payload.get("enabled"), bool):
                            raise ValueError("Choose Codex or Claude Code, on or off")
                        connect(payload["app"], payload["enabled"])
                    elif action == "detect":
                        found.update(detect(roots[0] if roots else None, claude_dir, isolated=args.claude_config is not None))
                        status_cache = claude_status()
                    elif action == "add_source":
                        source = Path(payload.get("path", "")).resolve(strict=True)
                        if not (source / "sessions").is_dir():
                            raise ValueError("Choose a Codex home containing a sessions folder")
                        if source not in roots:
                            roots.append(source)  # Shared with the live Codex reader.
                            roots_file.write_text(json.dumps([str(p) for p in roots]), encoding="utf-8")
                    elif action != "snapshot":
                        if action == "settings" and {"codex", "claude"} & set(payload):
                            raise ValueError("Use connect to change which apps Pocodex watches")
                        previous_active = engine.snapshot()["active"] if action == "evolve" else None
                        previous_species = previous_active["species"] if previous_active else None
                        engine.command(action, payload)
                        if action in ("pet", "berry", "evolve"):
                            events.append({"id": f"interaction-{engine.state['revision']}", "kind": action,
                                           "at": now, "previous_species": previous_species})
                        events.extend(engine.drain_events())
                        if action == "settings":
                            telemetry.set_previews(setting("message_previews"))
                            if not setting("message_previews"):
                                for event in events:
                                    event.pop("preview", None)
                                    event.pop("questions", None)
                    changed = True
                    emit({"id": message.get("id"), "state": snapshot(now), "events": events})
                except (ValueError, OSError) as error:
                    text = str(error) if isinstance(error, ValueError) else "Cannot access the selected local source"
                    send({"id": message.get("id"), "error": text})
                except Exception:  # The engine has rolled the save back; keep the companion running.
                    traceback.print_exc(file=sys.stderr)
                    send({"id": message.get("id"), "error": "That didn't work. Your save is unchanged"})
            if changed:
                observed = telemetry.snapshot(now)
            signature = (engine.state["revision"], json.dumps(observed, sort_keys=True), json.dumps(connections(), sort_keys=True))
            if events or signature != emitted_signature or now - last_emitted >= 5:
                emit({"type": "state", "state": snapshot(now, observed), "events": events})
                emitted_signature, last_emitted = signature, now
            time.sleep(0.5)
    finally:
        usage["stop"].set()  # a running usage check removes its Claude Code session before the process exits
        engine.close()
        if usage["thread"]:
            usage["thread"].join(10)


if __name__ == "__main__":
    main()
