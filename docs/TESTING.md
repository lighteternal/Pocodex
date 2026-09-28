# Testing

Pocodex is tested in layers, from pure logic up to the installed app. Every layer uses temporary profiles and temporary Codex and Claude Code folders: no test reads or changes your real collection, `~/.codex` or `~/.claude`. One exception touches Windows itself: the startup-registration test adds a value to your user's `Run` registry key, named after its temporary profile, and removes it when the test ends.

| Layer | Command (repository root) | Covers |
| --- | --- | --- |
| Python | `.venv\Scripts\python.exe -m unittest discover -s tests` | Growth rules and save migrations, the Codex log reader, the Claude Code adapter and hook entry point, the Claude settings editor, telemetry merging, startup registration |
| Node | `npm test --prefix companion` | Sprite sizing and grounding, state-to-animation mapping, allowance and lore text, pinned asset hashes, sidecar command allow-list |
| Desktop | `npm run test:ui --prefix companion` | Real Electron windows driven by Playwright with local event fixtures |
| Packaged | set `POCODEX_EXECUTABLE` to `artifacts\companion\win-unpacked\Pocodex.exe`, then run the desktop layer | The same scenarios against the built app |

The desktop layer needs an interactive Windows session because it opens real windows, including the transparent buddy.

## What the desktop scenarios check

- First run: Professor Oak's intro (typing, keyboard and mouse, the name, replaying from Settings), which apps are detected and pre-ticked, and that an unticked choice survives live refreshes.
- Connecting Claude Code into an isolated folder, the exact hooks it adds, and disconnecting back to the original file byte for byte.
- An unreadable Claude settings file: left untouched, explained, with a paste-in snippet.
- Both apps at once: one buddy gains XP from each, one alert queue, a permission prompt clearing once Claude Code resumes, and no prompt text on screen.
- Allowance boxes: observed, low (with the buddy warning), stale and corrupt snapshots, a usage limit hit in a desktop session emptying the Claude box until its reset, and the opt-in usage check reading a stand-in Claude Code's `/usage` screen with its guards on and its session removed.
- Codex flows: working, questions, answers, previews rendered as safe Markdown, notice lifetimes.
- Collection: hatching, evolution (one form per frame), pets and berries, the Pokédex (owned and seen), restarts.
- Battles: a full battle from Home to Continue, a form with no action sheet battling as its Pokédex sprite, one turn per double-click, Poké Ball spending, Home staying inert underneath, and resuming after a restart. The Python layer checks the type chart, stat, damage and catch formulas against the games, and every form's pinned battle data.
- Trainer Card: real records, badge count, the copied image on the clipboard, flipping, and name validation.
- Desktop behaviour: transparency, keep-on-top, dragging and saved position, tray commands, startup registration, quitting completely, reduced motion and sound rules.

## Claude Code hook speed

Claude Code runs Pocodex's hook on every registered event. The build measures the packaged `pocodex-hook.exe` and fails if its median start is slower than 300 ms (`scripts/measure_hook.py`).

## Real-app checks before a release

Automated scenarios use fixtures. The Python test for the real startup watcher only runs while the Codex desktop app is open; otherwise it is skipped, so run it with Codex open before a release. Then run one short real task in each app with the installed build and confirm on the desktop:

1. The buddy walks while the task runs and the app's status says Working.
2. A question from the agent appears in the Pokégear notice and clears after you reply.
3. The finished answer appears and the XP bar moves.
4. For Claude Code, unticking it in Settings restores `settings.json`.
