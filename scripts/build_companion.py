"""Build Pocodex's bundled Windows runtime and current-user installer."""

import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def run(args: list[str], cwd: Path = ROOT) -> None:
    print(json.dumps({"stage": "build", "command": args[0], "arguments": args[1:]}), flush=True)
    subprocess.run(args, cwd=cwd, check=True)


def main() -> None:
    if os.name != "nt":
        raise SystemExit("Pocodex's installer must be built with the native Windows toolchain")
    node = shutil.which("node")
    npm = shutil.which("npm.cmd")
    if not node or not npm:
        raise SystemExit("Build tools missing: install Node.js, then run npm ci inside companion")
    run([node, "scripts/companion_catalog.mjs"])
    run([node, "scripts/companion_actions.mjs"])
    run([node, "scripts/companion_battle.mjs"])
    run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-q"])
    run([node, "--test", *sorted(str(p.relative_to(ROOT)) for p in (ROOT / "companion/tests").glob("*.test.cjs"))])
    run([sys.executable, "scripts/build_pocodex_icon.py"])
    run([node, "scripts/build_companion_icons.cjs"])
    run([sys.executable, "-m", "PyInstaller", "--noconfirm", "--onefile", "--console",
         "--name", "pocodex-core", "--paths", str(ROOT / "src"),
         "--distpath", str(ROOT / "companion/runtime"), "--workpath", str(ROOT / "build/pocodex/work"),
         "--specpath", str(ROOT / "build/pocodex"), str(ROOT / "scripts/companion_entrypoint.py")])
    run([sys.executable, "-m", "PyInstaller", "--noconfirm", "--onefile", "--windowed",
         "--name", "pocodex-watcher", "--paths", str(ROOT / "src"),
         "--distpath", str(ROOT / "companion/runtime"), "--workpath", str(ROOT / "build/pocodex-watcher/work"),
         "--specpath", str(ROOT / "build/pocodex-watcher"), str(ROOT / "scripts/companion_watcher.py")])
    # Claude Code runs the hook on every hook event: a one-folder build avoids unpacking on each start.
    run([sys.executable, "-m", "PyInstaller", "--noconfirm", "--onedir", "--console",
         "--name", "pocodex-hook", "--paths", str(ROOT / "src"),
         "--distpath", str(ROOT / "companion/runtime"), "--workpath", str(ROOT / "build/pocodex-hook/work"),
         "--specpath", str(ROOT / "build/pocodex-hook"), str(ROOT / "scripts/companion_hook.py")])
    run([sys.executable, "scripts/measure_hook.py", str(ROOT / "companion/runtime/pocodex-hook/pocodex-hook.exe")])
    run([npm, "run", "package"], ROOT / "companion")
    output = ROOT / "artifacts/companion"
    version = json.loads((ROOT / "companion/package.json").read_text(encoding="utf-8"))["version"]
    artifacts = [output / f"Pocodex Setup {version}.exe", output / f"Pocodex-{version}-win.zip"]
    missing = [p.name for p in artifacts if not p.is_file()]
    if missing:
        raise SystemExit(f"Packaging did not produce the current release files: {', '.join(missing)}")
    sums = [f"{hashlib.file_digest(p.open('rb'), 'sha256').hexdigest()}  {p.name}" for p in artifacts]
    (output / "SHA256SUMS.txt").write_text("\n".join(sums) + "\n", encoding="ascii")
    print(json.dumps({"artifacts": [str(p) for p in artifacts], "published": False}, indent=2))


if __name__ == "__main__":
    main()
