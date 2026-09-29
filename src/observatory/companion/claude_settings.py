"""Add and remove Pocodex's Claude Code hooks and status line.

Every entry Pocodex writes carries the argument `--pocodex`; nothing without it is ever changed.
Connecting keeps a one-time backup, writes atomically and records the user's own status line first,
so disconnecting (from Settings or the uninstaller) puts it back. When nothing else changed meanwhile,
disconnecting restores the backup's exact bytes; otherwise it rewrites the file without Pocodex's entries.
"""

import ctypes
import json
import os
import re
import shutil
import tempfile
from pathlib import Path

MARK = "--pocodex"
HOOKS = (("UserPromptSubmit", None), ("Stop", None), ("StopFailure", None), ("SessionEnd", None),
         ("Notification", "permission_prompt|elicitation_dialog|agent_needs_input"),
         ("PreToolUse", "AskUserQuestion"), ("PostToolUse", "AskUserQuestion"))
SHELL_SAFE = re.compile(r"[\w.:/\\~-]+")


class SettingsUnreadable(ValueError):
    """settings.json exists but is not the JSON shape Claude Code documents; Pocodex leaves it alone."""


def config_dir(override: Path | None = None) -> Path:
    if override:
        return override
    configured = os.environ.get("CLAUDE_CONFIG_DIR", "").strip()
    return Path(configured).expanduser() if configured else Path.home() / ".claude"


def _connection_file(profile: Path) -> Path:
    return profile / "claude-connection.json"


def _read_connection(profile: Path) -> dict:
    try:
        value = json.loads(_connection_file(profile).read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _load(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as error:
        raise SettingsUnreadable("Claude Code settings are not plain JSON") from error
    hooks = value.get("hooks", {}) if isinstance(value, dict) else None
    if not isinstance(hooks, dict) or not all(isinstance(groups, list) for groups in hooks.values()):
        raise SettingsUnreadable("Claude Code settings have an unexpected shape")
    return value


def _replace(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".", suffix=".pocodex-tmp")
    try:
        with os.fdopen(handle, "wb") as file:
            file.write(content)
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def _write(path: Path, data: dict) -> None:
    _replace(path, (json.dumps(data, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))


def _ours(entry: object) -> bool:
    return isinstance(entry, dict) and (MARK in entry.get("args", []) or MARK in str(entry.get("command", "")).split())


def _short(path: str) -> str:
    """The 8.3 form of a spaced path, so one shell string works in Git Bash and PowerShell alike."""
    if " " not in path or os.name != "nt":
        return path
    buffer = ctypes.create_unicode_buffer(32768)
    size = ctypes.windll.kernel32.GetShortPathNameW(path, buffer, len(buffer))
    return buffer.value if 0 < size < len(buffer) else path


def _profile_args(profile: Path) -> list[str]:
    from observatory.companion.hook import default_profile
    return [] if profile.resolve() == default_profile().resolve() else ["--profile", str(profile)]


def hook_entry(command: list[str], profile: Path) -> dict:
    exe, *prefix = command
    return {"type": "command", "command": exe, "args": [*prefix, "claude-event", *_profile_args(profile), MARK],
            "async": True, "timeout": 10}


def status_command(command: list[str], profile: Path) -> str | None:
    """Claude Code runs status lines through a shell, so the command must survive both of Windows' shells."""
    exe, *prefix = command
    extra = _profile_args(profile)
    parts = [_short(exe), *prefix, "claude-statusline", *(["--profile", _short(extra[1])] if extra else []), MARK]
    if not all(SHELL_SAFE.fullmatch(part) for part in parts):
        return None  # Spaces or shell metacharacters: skip the status line rather than break it.
    return " ".join(part.replace("\\", "/") for part in parts)


def _groups(command: list[str], profile: Path) -> dict:
    hooks = {}
    for event, matcher in HOOKS:
        group = {"hooks": [hook_entry(command, profile)]}
        if matcher:
            group["matcher"] = matcher
        hooks.setdefault(event, []).append(group)
    return hooks


def snippet(command: list[str], profile: Path) -> str:
    """What to paste by hand when Pocodex cannot safely edit the file itself."""
    return json.dumps({"hooks": _groups(command, profile)}, indent=2)


def _strip(data: dict, original_status: dict | None) -> dict:
    result = dict(data)
    hooks = {}
    for event, groups in result.get("hooks", {}).items():
        kept = []
        for group in groups:
            entries = group.get("hooks") if isinstance(group, dict) else None
            if not isinstance(entries, list):
                kept.append(group)
                continue
            mine = [h for h in entries if _ours(h)]
            if not mine:
                kept.append(group)
            elif len(mine) < len(entries):
                kept.append({**group, "hooks": [h for h in entries if not _ours(h)]})
        if kept:
            hooks[event] = kept
    if hooks:
        result["hooks"] = hooks
    else:
        result.pop("hooks", None)
    if _ours(result.get("statusLine")):
        if original_status:
            result["statusLine"] = original_status
        else:
            result.pop("statusLine", None)
    return result


def _our_hooks(data: dict) -> list:
    return [h for groups in data.get("hooks", {}).values() for g in groups if isinstance(g, dict)
            for h in (g.get("hooks") if isinstance(g.get("hooks"), list) else []) if _ours(h)]


def _marked(data: dict) -> bool:
    return bool(_our_hooks(data)) or _ours(data.get("statusLine"))


def _apply(data: dict, command: list[str], profile: Path, saved: dict) -> dict:
    existing = data.get("statusLine")
    if isinstance(existing, dict) and not _ours(existing):
        saved["status_line"] = existing
    result = _strip(data, saved.get("status_line"))
    hooks = result.setdefault("hooks", {})
    for event, groups in _groups(command, profile).items():
        hooks.setdefault(event, []).extend(groups)
    line = status_command(command, profile)
    if line:
        original = saved.get("status_line") or {}
        result["statusLine"] = {"type": "command", "command": line, "padding": original.get("padding", 0)}
    return result


def connect(config: Path, command: list[str], profile: Path) -> dict:
    path = config / "settings.json"
    for _ in range(2):
        before = _load(path)
        backup = config / "settings.json.pocodex-backup"
        if path.exists() and not backup.exists():
            shutil.copyfile(path, backup)
        saved = _read_connection(profile)
        updated = _apply(before, command, profile, saved)
        if _load(path) != before:
            continue  # Claude Code rewrote the file meanwhile; start again from its version.
        _write(_connection_file(profile), {**saved, "config": str(config), "connected": True})
        _write(path, updated)
        return status(config, command, profile)
    raise SettingsUnreadable("Claude Code settings kept changing; try again")


def _backup_if_same(config: Path, stripped: dict) -> bytes | None:
    """The untouched original, when stripping Pocodex out left nothing but formatting to tell them apart."""
    backup = config / "settings.json.pocodex-backup"
    try:
        original = _load(backup)
        if backup.exists() and not _marked(original) and _strip(original, None) == stripped:
            return backup.read_bytes()
    except (OSError, SettingsUnreadable):
        pass
    return None


def disconnect(config: Path, profile: Path) -> dict:
    path = config / "settings.json"
    saved = _read_connection(profile)
    for _ in range(2):
        before = _load(path)
        updated = _strip(before, saved.get("status_line"))
        original = _backup_if_same(config, updated) if _marked(before) else None
        if _load(path) != before:
            continue  # Claude Code rewrote the file meanwhile; start again from its version.
        if original is not None:
            _replace(path, original)
        elif _marked(before):
            _write(path, updated)
        if _connection_file(profile).exists():
            _write(_connection_file(profile), {"config": str(config), "connected": False})
        return {"readable": True, "connected": False, "current": False, "status_line": False}
    raise SettingsUnreadable("Claude Code settings kept changing; try again")


def disconnect_saved(profile: Path) -> None:
    """Uninstaller entry: remove whatever this profile connected, without failing the uninstall."""
    saved = _read_connection(profile)
    if saved.get("connected") and saved.get("config"):
        try:
            disconnect(Path(saved["config"]), profile)
        except (OSError, SettingsUnreadable):
            pass


def status(config: Path, command: list[str], profile: Path) -> dict:
    try:
        data = _load(config / "settings.json")
    except (OSError, SettingsUnreadable):
        return {"readable": False, "connected": False, "current": False, "status_line": False}
    ours = _our_hooks(data)
    expected, line = hook_entry(command, profile), status_command(command, profile)
    has_line = _ours(data.get("statusLine"))
    line_ok = data["statusLine"].get("command") == line if has_line else line is None
    return {"readable": True, "connected": bool(ours), "status_line": has_line,
            "current": len(ours) == len(HOOKS) and all(h == expected for h in ours) and line_ok}
