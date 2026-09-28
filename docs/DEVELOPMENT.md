# Build and develop on Windows

Use native Windows Python 3.12 and Node 24, from PowerShell in the repository root. Don't build a Windows-drive checkout through WSL.

```powershell
git clone https://github.com/lighteternal/Pocodex.git
cd Pocodex
python -m venv .venv
.venv\Scripts\python.exe -m pip install -e ".[build]"
npm ci --prefix companion
.venv\Scripts\python.exe scripts/build_companion.py
```

The build downloads and verifies the pinned Pokémon assets (454 catalog files and 2,113 action-sprite resources), copies the pinned battle data, runs the Python and Node tests, bundles three Python executables (the sidecar, the startup watcher and the Claude Code hook), checks the hook's start-up time, then writes an installer, a portable ZIP and `SHA256SUMS.txt` to `artifacts/companion`. A changed upstream hash fails the build.

## Running from source

```powershell
npm start --prefix companion
```

This uses your real profile and your real Codex and Claude Code folders, like the installed app. For a sandbox, pass your own folders:

```powershell
npx --prefix companion electron companion --profile="C:\trial\profile" --source="C:\trial\codex" --claude-config="C:\trial\claude" --show-home
```

`--source` is a Codex home containing `sessions`. `--claude-config` is the folder whose `settings.json` Pocodex may edit; when given, it is also the only place Pocodex looks for Claude Code.

## How the pieces fit

- `companion/` is the Electron shell: `main.cjs` owns the windows, tray and sidecar; `ui/` is the sandboxed renderer.
- `src/observatory/companion/` is the Python sidecar. `sources/codex.py` and `sources/claude.py` turn each app's records into one event vocabulary, `telemetry.py` merges them, and `engine.py` owns the save and growth rules.
- `hook.py` is the small entry point Claude Code runs for each hook and for the status line. `claude_settings.py` adds and removes Pocodex's entries in Claude Code's settings.
- [docs/design/unified-tracking.md](design/unified-tracking.md) explains the two-app design; [SPRITE-ACTIONS.md](SPRITE-ACTIONS.md) maps states to sprite actions.

## Tests

See [Testing](TESTING.md). In short:

```powershell
.venv\Scripts\python.exe -m unittest discover -s tests
npm test --prefix companion
npm run test:ui --prefix companion
```

## Assets and demo media

Only maintainers updating the roster should run `node scripts/companion_catalog.mjs --refresh-catalog`, `node scripts/companion_actions.mjs --refresh` or `node scripts/companion_battle.mjs --refresh`. Review evolution rules, form mapping, credits and hash changes in `companion/data` before committing.

To refresh the README's GIFs and Home screenshot, install FFmpeg and run `node scripts/capture_demos.cjs`. It records the real app with a seeded collection and synthetic events, never your desktop or collection. Check the media in `docs/images` before committing.

For a process-tree resource measurement of a built app:

```powershell
$env:POCODEX_EXECUTABLE = (Resolve-Path artifacts\companion\win-unpacked\Pocodex.exe).Path
node scripts/measure_pocodex.cjs 300
Remove-Item Env:\POCODEX_EXECUTABLE
```

## Releases

Pocodex is released as source only: no installer, ZIP or other build is published, because a build bundles the Pokémon sprites and cries it downloads. A release is a tagged commit. Before tagging, build from a clean checkout, run the desktop tests against the packaged app, install it for your user and try one real task in each app (see [Testing](TESTING.md)).

Keep the `appId` in `companion/package.json` (`local.codexcompanion.desktop`, from the earliest builds) unchanged: Windows identifies an existing install by it, so a new value would install a second copy instead of upgrading.

The MIT licence covers original code only, not Pokémon material.
