"""Claude allowance from Claude Code's own /usage screen, for people who only use the desktop app.

The desktop app runs Claude Code headless, so it never runs the status line that carries live
allowance. Claude Code's interactive /usage screen shows the same numbers and asks Anthropic for
them itself, without a model request. When the Trainer turns the check on, Pocodex starts their own
Claude Code in the background, reads that screen and removes the session again.

Two guards keep it free: hooks are off for the check, so it never looks like work, and the model is
one that does not exist, so even a misread command fails before it could spend a token.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

MODEL_GUARD = "pocodex-usage-check-no-model"
EVERY_SECONDS = 600
WINDOWS = {"five_hour": "Current session", "seven_day": "Current week (all models)"}
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07")
USED = re.compile(r"(\d{1,3}(?:\.\d+)?)%\s+used")
RESET = re.compile(r"Resets\s+(?:(?P<month>[A-Z][a-z]{2})\s+(?P<day>\d{1,2}),?\s+(?:at\s+)?)?"
                   r"(?P<hour>\d{1,2})(?::(?P<minute>\d{2}))?\s*(?P<half>am|pm)", re.IGNORECASE)
MONTHS = {name: number for number, name in enumerate(("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"), 1)}


class UsageCheckError(Exception):
    """A reason the check could not read Claude Code's usage, worded for the Settings page."""


def find_cli() -> str | None:
    """The Windows Claude Code CLI, which keeps its own sign-in fresh when it runs."""
    found = shutil.which("claude")
    if found:
        return found
    default = Path(os.environ.get("USERPROFILE") or Path.home()) / ".local" / "bin" / "claude.exe"
    return str(default) if default.is_file() else None


def _reset(match: re.Match, now: float) -> float:
    """A reset shown in local time ("9:10pm", "Sep 30, 10pm") as Unix seconds; Claude Code runs on this PC."""
    hour = int(match["hour"]) % 12 + (12 if match["half"].lower() == "pm" else 0)
    minute = int(match["minute"] or 0)
    today = datetime.fromtimestamp(now)
    if match["month"]:
        month = MONTHS.get(match["month"].title())
        if not month:
            raise ValueError(match["month"])
        moment = today.replace(month=month, day=int(match["day"]), hour=hour, minute=minute, second=0, microsecond=0)
        if moment.timestamp() < now - 180 * 86400:  # "Jan 2" seen in late December
            moment = moment.replace(year=moment.year + 1)
    else:
        moment = today.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if moment.timestamp() <= now - 60:
            moment += timedelta(days=1)
    return moment.timestamp()


def parse(screen: str, now: float) -> dict | None:
    """The 5-hour and weekly windows from the latest drawing of the /usage screen, in status-line shape."""
    text = ANSI.sub("", screen)
    start = text.rfind(WINDOWS["five_hour"])
    if start < 0:
        return None
    text = text[start:]
    limits = {}
    for name, heading in WINDOWS.items():
        at = text.find(heading)
        if at < 0:
            continue
        section = text[at + len(heading):]
        following = re.search(r"Current (session|week)|What's contributing", section)
        section = section[:following.start()] if following else section
        used, reset = USED.search(section), RESET.search(section)
        if not used:
            continue
        try:
            resets_at = _reset(reset, now) if reset else None
        except ValueError:
            resets_at = None
        limits[name] = {"used_percentage": min(100.0, float(used[1])), "resets_at": resets_at}
    return limits if "five_hour" in limits else None


def _problem(screen: str) -> str | None:
    text = ANSI.sub("", screen).lower()
    if "trust" in text and "folder" in text:
        return "Claude Code asked whether to trust Pocodex's check folder. Open Claude Code there once to allow it."
    if "/login" in text or "not logged in" in text or "please log in" in text:
        return "Claude Code isn't signed in on this PC. Run claude once in a terminal to sign in."
    if "only available for subscription" in text or "subscription plans" in text:
        return "Claude Code shows plan usage only for Claude subscriptions."
    return None


def _text(value) -> str:
    return value.decode("utf-8", "replace") if isinstance(value, bytes) else value or ""


def check(cli: str, workdir: Path, now: float | None = None, run=subprocess.run, wait=time.sleep, patience: float = 20) -> dict:
    """Run /usage in a background Claude Code session and return its windows; always removes the session.

    A wait that returns true (threading.Event.wait once set) means Pocodex is closing: stop and clean up now."""
    workdir.mkdir(parents=True, exist_ok=True)
    # Settings as a file, not inline JSON: no quotes for Windows to mangle on the way to Claude Code.
    guard = workdir / "check-settings.json"
    try:
        guard.write_text(json.dumps({"disableAllHooks": True}), encoding="utf-8")
    except OSError as error:
        raise UsageCheckError("Couldn't prepare Pocodex's usage-check folder.") from error
    # stdin is empty: the sidecar's own stdin is Pocodex's command pipe, and Claude Code reads piped input as a prompt.
    options = {"cwd": str(workdir), "stdin": subprocess.DEVNULL, "capture_output": True, "text": True, "encoding": "utf-8", "errors": "replace",
               "timeout": 30, "creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}
    call = lambda *arguments: run([cli, *arguments], **options)
    try:
        started = call("--bg", "--model", MODEL_GUARD, "--settings", str(guard), "/usage")
    except subprocess.TimeoutExpired as error:  # it may have backgrounded the session, and said so, before hanging
        started = error
    except (OSError, subprocess.SubprocessError) as error:
        raise UsageCheckError("Couldn't start Claude Code for the usage check.") from error
    output = ANSI.sub("", _text(started.stdout) + _text(started.stderr))
    ident = re.search(r"backgrounded\s*\S\s*([0-9a-f]{6,})", output)
    if not ident:
        unsure = isinstance(started, subprocess.TimeoutExpired) or "backgrounded" in output
        raise UsageCheckError(_problem(output) or ("Claude Code didn't say which background session the usage check started, so one may be left running."
                                                   if unsure else "Claude Code didn't start a background session for the usage check."))
    ident = ident[1]
    deadline = time.monotonic() + patience
    try:
        while True:
            try:
                screen = call("logs", ident).stdout or ""
            except (OSError, subprocess.SubprocessError):
                screen = ""
            limits = parse(screen, now if now is not None else time.time())
            if limits:
                return limits
            problem = _problem(screen)
            if problem:
                raise UsageCheckError(problem)
            if time.monotonic() >= deadline:
                raise UsageCheckError("Claude Code's usage screen didn't show plan usage. A newer Claude Code may have changed it.")
            if wait(1.5):
                raise UsageCheckError("Pocodex closed before the usage check finished.")
    finally:
        for step in ("stop", "rm"):
            try:
                code = call(step, ident).returncode
            except (OSError, subprocess.SubprocessError) as error:
                code = type(error).__name__
            if code:
                print(f"Claude usage check: claude {step} {ident} failed ({code}); that background session may be left", file=sys.stderr)
