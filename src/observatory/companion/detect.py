"""Is Codex or Claude Code on this PC? Read-only checks; nothing is started or changed."""

import os
import shutil
from pathlib import Path


def detect(codex_home: Path | None = None, claude_config: Path | None = None, env=os.environ, isolated: bool = False) -> dict:
    """isolated: a folder chosen for a trial or test is the only place that counts."""
    home = Path.home()
    codex = codex_home or (Path(env["CODEX_HOME"]) if env.get("CODEX_HOME", "").strip() else home / ".codex")
    claude = claude_config or (Path(env["CLAUDE_CONFIG_DIR"]) if env.get("CLAUDE_CONFIG_DIR", "").strip() else home / ".claude")
    # The Claude desktop app keeps its own Claude Code build here, even without a CLI on PATH.
    bundled = Path(env.get("APPDATA") or home / "AppData" / "Roaming") / "Claude" / "claude-code"
    claude_found = claude.is_dir() or (not isolated and (bool(shutil.which("claude", path=env.get("PATH", ""))) or any(bundled.glob("*/claude.exe"))))
    return {"codex": {"found": (codex / "sessions").is_dir(), "path": str(codex)},
            "claude": {"found": claude_found, "path": str(claude)}}
