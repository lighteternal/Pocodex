"""Opt-in Windows desktop watcher. No Electron, admin rights or model calls."""

import argparse
import ctypes
import hashlib
import json
import os
import subprocess
import sys
import time
from ctypes import wintypes
from pathlib import Path, PureWindowsPath


RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"


class ProcessEntry(ctypes.Structure):
    _fields_ = [("size", wintypes.DWORD), ("usage", wintypes.DWORD), ("pid", wintypes.DWORD),
                ("heap", ctypes.c_size_t), ("module", wintypes.DWORD), ("threads", wintypes.DWORD),
                ("parent", wintypes.DWORD), ("priority", wintypes.LONG), ("flags", wintypes.DWORD),
                ("name", wintypes.WCHAR * 260)]


def registration_name(profile: Path) -> str:
    return "Pocodex-" + hashlib.sha256(str(profile.resolve()).lower().encode()).hexdigest()[:12]


def is_codex_desktop(filename: str) -> bool:
    path = PureWindowsPath(filename.lower())
    return (path.name in {"chatgpt.exe", "codex.exe"} and path.parent.name == "app"
            and path.parent.parent.name.startswith(("openai.codex_", "openai.chatgpt_")))


def desktop_processes() -> set[int]:
    """Read process image paths, never command lines or chat content."""
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)

    kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry)]
    kernel.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry)]
    kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    snapshot = kernel.CreateToolhelp32Snapshot(2, 0)
    if snapshot == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    matches = {}
    try:
        entry = ProcessEntry(size=ctypes.sizeof(ProcessEntry))
        available = kernel.Process32FirstW(snapshot, ctypes.byref(entry))
        while available:
            if entry.name.lower() in {"chatgpt.exe", "codex.exe"}:
                process = kernel.OpenProcess(0x1000, False, entry.pid)
                if process:
                    try:
                        buffer = ctypes.create_unicode_buffer(32768)
                        size = wintypes.DWORD(len(buffer))
                        if kernel.QueryFullProcessImageNameW(process, 0, buffer, ctypes.byref(size)) and is_codex_desktop(buffer.value):
                            matches[entry.pid] = entry.parent
                    finally:
                        kernel.CloseHandle(process)
            available = kernel.Process32NextW(snapshot, ctypes.byref(entry))
    finally:
        kernel.CloseHandle(snapshot)
    return {pid for pid, parent in matches.items() if parent not in matches}


class LaunchGate:
    """Renderer churn is not a new desktop session. Explicit quit never respawns."""

    def __init__(self, current: set[int] | None = None):
        self.previous = current or set()

    def observe(self, current: set[int]) -> bool:
        launch = bool(current and not current.intersection(self.previous))
        self.previous = current
        return launch


def startup_status(profile: Path) -> dict:
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
            registered, _ = winreg.QueryValueEx(key, registration_name(profile))
        config = json.loads((profile / "startup.json").read_text(encoding="utf-8"))
        expected = subprocess.list2cmdline([*config["watcher"], "--profile", str(profile)])
        enabled = registered == expected
    except (FileNotFoundError, KeyError, ValueError):
        enabled = False
    return {"enabled": enabled, "paused": (profile / "startup-paused").exists()}


def configure(profile: Path, enabled: bool, launch: list[str] | None = None, watcher: list[str] | None = None) -> dict:
    import winreg
    profile.mkdir(parents=True, exist_ok=True)
    if enabled:
        for command in (launch, watcher):
            if not command or not all(isinstance(arg, str) for arg in command) or not Path(command[0]).is_absolute() or not Path(command[0]).is_file():
                raise ValueError("Startup executable is unavailable. Reinstall Pocodex before enabling startup.")
        config = {"launch": launch, "watcher": watcher}
        (profile / "startup.json").write_text(json.dumps(config), encoding="utf-8")
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
            winreg.SetValueEx(key, registration_name(profile), 0, winreg.REG_SZ,
                             subprocess.list2cmdline([*watcher, "--profile", str(profile)]))
        (profile / "startup-paused").unlink(missing_ok=True)
    else:
        (profile / "startup-paused").touch()
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as key:
                winreg.DeleteValue(key, registration_name(profile))
        except FileNotFoundError:
            pass
    return startup_status(profile)


def watch(profile: Path, skip_current: bool = False) -> None:
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
    kernel.CreateMutexW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    mutex = kernel.CreateMutexW(None, False, "Local\\" + registration_name(profile))
    if not mutex:
        raise ctypes.WinError(ctypes.get_last_error())
    duplicate = ctypes.get_last_error() == 183
    try:
        if duplicate or (profile / "startup-paused").exists():
            return
        (profile / "startup-watcher.pid").write_text(str(os.getpid()), encoding="ascii")
        gate = LaunchGate(desktop_processes() if skip_current else None)
        while not (profile / "startup-paused").exists() and startup_status(profile)["enabled"]:
            if gate.observe(desktop_processes()):
                config = json.loads((profile / "startup.json").read_text(encoding="utf-8"))
                if not Path(config["launch"][0]).is_file():
                    configure(profile, False)
                    raise FileNotFoundError("Pocodex moved or was removed; startup disabled")
                subprocess.Popen(config["launch"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
            time.sleep(2)
    finally:
        if not duplicate:
            (profile / "startup-watcher.pid").unlink(missing_ok=True)
        kernel.CloseHandle(mutex)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", type=Path, required=True)
    parser.add_argument("--watch", action="store_true")
    parser.add_argument("--skip-current", action="store_true")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--configure", choices=("enable", "disable", "status", "pause"), default="status")
    parser.add_argument("--launch-json")
    parser.add_argument("--watcher-json")
    args = parser.parse_args()
    try:
        if args.watch:
            if args.resume:
                (args.profile / "startup-paused").unlink(missing_ok=True)
            watch(args.profile, args.skip_current)
        else:
            if args.configure == "pause":
                (args.profile / "startup-paused").touch()
            result = startup_status(args.profile) if args.configure in {"status", "pause"} else configure(
                args.profile, args.configure == "enable", json.loads(args.launch_json or "null"), json.loads(args.watcher_json or "null"))
            print(json.dumps(result), flush=True)
    except (OSError, ValueError) as error:
        diagnostic = {"event": "startup_failed", "code": getattr(error, "winerror", None) or getattr(error, "errno", None),
                      "message": "Startup could not be configured or launched. Check that Pocodex is installed and your user startup settings are writable."}
        if args.watch:
            (args.profile / "startup-error.json").write_text(json.dumps(diagnostic), encoding="utf-8")
        else:
            print(json.dumps(diagnostic), file=sys.stderr, flush=True)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
