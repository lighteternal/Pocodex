"""Claude Code hook and status-line entry point.

Claude Code runs this on every registered hook, so it imports only the standard library, writes
one line and exits. It never stores the prompt, and keeps question text only when message
previews are on. Failures are swallowed: a missed line costs one reaction, never a Claude turn.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

EVENTS = {"UserPromptSubmit", "Stop", "StopFailure", "SessionEnd", "Notification", "PreToolUse", "PostToolUse"}
CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]")


def default_profile() -> Path:
    return Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming") / "Pocodex"


def _profile(argv: list[str]) -> Path:
    return Path(argv[argv.index("--profile") + 1]) if "--profile" in argv[:-1] else default_profile()


def _clip(value: object, limit: int) -> str:
    text = CONTROL.sub("", value[:4096]).strip() if isinstance(value, str) else ""
    return text[:limit - 1] + "…" if len(text) > limit else text


def _read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _questions(tool_input: object) -> list[dict]:
    values = tool_input.get("questions", []) if isinstance(tool_input, dict) else []
    return [{"text": _clip(q.get("question"), 300),
             "options": [_clip(o.get("label") if isinstance(o, dict) else o, 100) for o in q.get("options", [])[:5]]}
            for q in (values[:3] if isinstance(values, list) else []) if isinstance(q, dict) and isinstance(q.get("options", []), list)]


def event_line(payload: dict, profile: Path, now: float) -> dict | None:
    name = payload.get("hook_event_name")
    if name not in EVENTS:
        return None
    line = {"at": now, "event": name, "session": str(payload.get("session_id", ""))[:100],
            "project": str(payload.get("cwd", "")).replace("\\", "/").rstrip("/").split("/")[-1][:100],
            "transcript": str(payload.get("transcript_path", ""))[:1000]}
    if name == "Notification":
        line["notification"] = str(payload.get("notification_type", ""))[:40]
    if name == "SessionEnd":
        line["reason"] = str(payload.get("reason", ""))[:40]
    if name in ("PreToolUse", "PostToolUse"):
        line["tool"] = str(payload.get("tool_name", ""))[:60]
        if name == "PreToolUse" and line["tool"] == "AskUserQuestion" and _read_json(profile / "claude-hook.json").get("previews"):
            line["questions"] = _questions(payload.get("tool_input"))
    return line


def _write_atomic(path: Path, value: dict) -> None:
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value), encoding="utf-8")
    os.replace(temporary, path)


def git_bash() -> str | None:
    """Claude Code runs status lines with Git Bash, else PowerShell. Never WSL's System32 bash."""
    git = shutil.which("git")
    candidates = [Path(git).resolve().parents[1] / "bin" / "bash.exe"] if git else []
    candidates.append(Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git" / "bin" / "bash.exe")
    return next((str(p) for p in candidates if p.is_file()), None)


def _wrapped(command: str, raw: str) -> str:
    bash = git_bash()
    args = [bash, "-c", command] if bash else ["powershell.exe", "-NoProfile", "-Command", command]
    try:
        return subprocess.run(args, input=raw, capture_output=True, text=True, encoding="utf-8", timeout=5,
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def status_line(profile: Path, raw: str) -> str:
    payload = json.loads(raw) if raw.strip() else {}
    limits = payload.get("rate_limits") if isinstance(payload, dict) else None
    if isinstance(limits, dict) and limits:
        _write_atomic(profile / "claude-limits.json", {"at": time.time(), "rate_limits": limits})
    original = _read_json(profile / "claude-connection.json").get("status_line")
    if isinstance(original, dict) and isinstance(original.get("command"), str):
        # The user's own status line keeps its place; Pocodex only listens in.
        return _wrapped(original["command"], raw)
    buddy = _read_json(profile / "buddy-status.json")
    parts = ["Pocodex"]
    if buddy.get("name"):
        parts.append(f"{buddy['name']} Lv. {buddy['level']}" if buddy.get("level") else str(buddy["name"]))
    five = limits.get("five_hour") if isinstance(limits, dict) else None
    used = five.get("used_percentage") if isinstance(five, dict) else None
    if isinstance(used, (int, float)) and not isinstance(used, bool):
        parts.append(f"5h {max(0, round(100 - used))}% left")
    return " · ".join(parts) + "\n"


def main(argv: list[str] | None = None, stdin=None, stdout=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if stdin is None:
        # Windows pipes default to the ANSI code page; Claude Code speaks UTF-8.
        for stream in (sys.stdin, sys.stdout):
            try:
                stream.reconfigure(encoding="utf-8")
            except (AttributeError, ValueError):
                pass
    stdin, stdout = stdin or sys.stdin, stdout or sys.stdout
    mode, profile = (argv[0] if argv else ""), _profile(argv)
    if mode == "claude-disconnect":
        from observatory.companion.claude_settings import disconnect_saved
        disconnect_saved(profile)
        return 0
    try:
        raw = stdin.read(1024 * 1024)
        profile.mkdir(parents=True, exist_ok=True)
        if mode == "claude-event":
            payload = json.loads(raw)
            line = event_line(payload, profile, time.time()) if isinstance(payload, dict) else None
            if line:
                with (profile / "claude-inbox.jsonl").open("a", encoding="utf-8") as inbox:
                    inbox.write(json.dumps(line, ensure_ascii=True) + "\n")
        elif mode == "claude-statusline":
            stdout.write(status_line(profile, raw))
    except (OSError, ValueError):
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
