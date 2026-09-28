# Pocodex 0.2: unified Codex + Claude Code tracking

Design for Pocodex 0.2, September 2026. The shipped behaviour is covered by the tests listed at the end.

## Goal

One Pokémon companion that grows and reacts to work in **both** the Codex desktop app and Claude Code on Windows, with "how much allowance is left" per app as the first thing on Home.

Key decisions:

| Question | Decision |
|---|---|
| Headline view | Allowance left per app (5-hour and weekly), side by side, honest "not observable" states |
| XP when both apps work at once | Each app earns separately (both busy = 2× XP). Parallel chats inside one app still count once |
| App attribution | Small `Codex` / `Claude` tag on Pokégear notices and Recent activity; buddy bubble untagged unless both apps need you |
| Claude connection | Hooks + status line in `~/.claude/settings.json`, installed only after the Trainer ticks Claude; transcripts only as a best-effort token source |
| Scope | Windows Codex + Windows Claude Code. WSL Claude Code is a follow-up |

Non-goals for 0.2: WSL Claude Code, non-Windows platforms, any network call, any model call, reading prompt or answer text beyond the existing opt-in previews.

## Facts this design relies on

From the Claude Code documentation (hooks, statusline, sessions pages on code.claude.com/docs):

- Hooks run for the CLI, the Claude desktop app's Code tab and the VS Code extension, all reading `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`).
- Hook stdin JSON carries `session_id`, `transcript_path`, `cwd`, `hook_event_name`; `Notification` adds `notification_type` (`permission_prompt`, `idle_prompt`, `elicitation_dialog`, `agent_needs_input`, …); `PreToolUse` adds `tool_name`, `tool_input`.
- A command hook with `args` (exec form) bypasses the shell; without it Windows uses Git Bash or PowerShell. Hooks accept `"async": true`.
- Plan allowance is exposed **only** through the status-line command's stdin: `rate_limits.five_hour` / `seven_day` with `used_percentage` and `resets_at` (Unix seconds), for Pro/Max accounts, absent until the first response of a session. The Claude desktop app runs Claude Code headless (`--output-format stream-json`), which never runs a status line, so desktop sessions never report live percentages. Transcripts carry no running percentage, but when a request is refused for a usage limit, Claude Code logs an entry with `quotaLimits` (`status: "rejected"`, `rateLimitType` `five_hour` or `seven_day`, `resetsAt` in Unix seconds), desktop sessions included. The unofficial `/api/oauth/usage` endpoint was ruled out: the desktop app does not refresh the Windows sign-in file, and the endpoint answers other clients with a one-hour 429. Instead, an opt-in check (`claude_usage.py`, off by default) runs the Trainer's own Windows Claude Code every 10 minutes: `claude --bg --model pocodex-usage-check-no-model --settings <file with disableAllHooks> /usage` with an empty stdin, then `claude logs <id>` until the screen shows "Current session" and "Current week (all models)", then `claude stop` and `claude rm`. The readings go through the same `claude-limits.json` path as the status line, marked `source: usage_check` and fresh for 15 minutes. Tests pass `--claude-config`, which confines the check to an explicit `--claude-cli` stand-in.
- Transcript entries are documented as internal and version-unstable. Observed locally (Claude Code on this machine): assistant entries carry `message.usage` with `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`, and `message.stop_reason`. Pocodex parses them defensively and never depends on them for state.

## 1. Architecture and data flow

```
Codex logs ──► sources/codex.py ─┐
                                 ├─► Telemetry (merge) ─► service snapshot ─► Electron windows
Claude hooks ─► claude-inbox ─┐  │         ▲
Claude status line ─► limits ─┼► sources/claude.py        │
Claude transcript (tail) ─────┘                  engine.credit(app, …)
```

- `src/observatory/companion/sources/codex.py`: today's `Sources` class, moved, behaviour unchanged, events gain `"app": "codex"`.
- `src/observatory/companion/sources/claude.py`: new adapter. Reads the inbox and allowance files written by the hook and status-line commands; stats `transcript_path` for heartbeats; tails the transcript on `Stop` for token usage and, if previews are on, the last answer excerpt.
- `src/observatory/companion/telemetry.py`: merges adapters into the existing snapshot shape: `running`/`waiting` totals plus `apps: {codex: {...}, claude: {...}}` with per-app activity, allowance windows and today's tokens and active seconds; one `attention` queue whose events carry `app`.
- Normalised event kinds (unchanged vocabulary): `completed`, `input_needed`, `stopped`, `low_allowance`, `limit_reached`, plus engine events `level_up`, `evolution_ready`, `break_reminder`. Every telemetry event has `app`.
- Normalised allowance snapshot: `{app, window: "5h" | "weekly", remaining, resets_at, observed_at, stale}`.

### Hook and status-line commands

- New binary `pocodex-hook.exe` (small PyInstaller build containing only the hook module; `--onedir` unless a `--onefile` build measures under the start-up budget). Budget: **≤ 300 ms** wall time per invocation on this machine, measured in the build.
- Modes:
  - `pocodex-hook.exe claude-event --profile <dir>`: reads hook JSON from stdin, appends one line `{at, event, session, cwd_name, transcript, notification_type?, tool?, questions?}` to `<profile>/claude-inbox.jsonl`, exits 0. Never stores `prompt`. `questions` only for `PreToolUse` on `AskUserQuestion` and only as bounded excerpts (same limits as Codex previews); dropped by the adapter when previews are off.
  - `pocodex-hook.exe claude-statusline --profile <dir>`: reads status-line JSON, writes `rate_limits` atomically to `<profile>/claude-limits.json`, then prints either the wrapped original status-line command's output (stdin passed through) or a short Pocodex line, e.g. `Pocodex · Pikachu Lv. 12 · 5h 77% left`.
- Registered hooks (all exec form with `args`, `async: true`): `UserPromptSubmit`, `Stop`, `StopFailure`, `SessionEnd`, `Notification` (matcher `permission_prompt|elicitation_dialog|agent_needs_input`), `PreToolUse` (matcher `AskUserQuestion`), `PostToolUse` (matcher `AskUserQuestion`).
- The profile directory is the Electron `userData` folder (`%APPDATA%\Pocodex`, or `--profile` in tests), so test profiles are fully isolated.

## 2. Connecting the apps

- **When**: the first launch of 0.2 (fresh install or upgrade; the installer opens Pocodex when it finishes) shows a one-time **Connect your apps** card on Home before anything else. The same toggles live in **Settings → Connections** with live status (`Connected · last event 2 min ago`, `Waiting for first Claude reply`, `Not connected`, `Not found on this PC · Check again`).
- **Detection**:
  - Codex: `CODEX_HOME` or `~/.codex/sessions` exists. Pre-ticked when found, and always for 0.1.x upgrades.
  - Claude Code: `CLAUDE_CONFIG_DIR` or `~/.claude` exists, or `claude.exe` resolves on `PATH`. Pre-ticked when found.
- **Consent**: the card names the one file the Claude tick changes (`~/.claude/settings.json`). Nothing is written before the Trainer confirms.
- **Settings editor** (`src/observatory/companion/claude_settings.py`):
  - One-time copy `settings.json.pocodex-backup` before the first change.
  - Parse strict JSON; if parsing fails or the root is not an object, change nothing and show "Couldn't read your Claude settings" with the exact snippet to paste.
  - Add only Pocodex entries; every entry's command is the absolute path of `pocodex-hook.exe`, which is how Pocodex finds its own entries later.
  - Existing `statusLine`: store its command in `<profile>/claude-connection.json` and register Pocodex's status line with `--wrap`; restore the original on disconnect.
  - Re-read immediately before writing; write to a temporary file in the same folder and rename.
  - Connect and disconnect are idempotent; unknown keys, other hooks and formatting-irrelevant content are preserved.
- **Removal**: unticking Claude removes exactly Pocodex's entries and restores the status line. The NSIS `customUnInstall` macro runs `pocodex-hook.exe claude-disconnect --profile "$APPDATA\Pocodex"` on real uninstall (not on `${isUpdated}`), so no dangling commands remain.
- **Self-heal**: on every launch, if connected and the registered hook path differs from the current install path, Pocodex rewrites its own entries only.
- **Codex**: no configuration change; unticking stops watching its folders.

## 3. Growth rules and homogenised messages

### Engine

- `credited_until` becomes `{app: timestamp}`. Migration: an existing scalar becomes `{"codex": value}`. A newly connected app starts at connection time: no back-pay.
- `credit(app, start, end)`: per-app watermark prevents double credit per app; different apps add up. Service credits each app separately from its own `running` state (same ≤ 5 s gap rule as today).
- Egg incubation, `active_seconds` (evolution time requirements) and XP all sum across apps. Each individual gains `active_by_app: {codex, claude}` (existing saves: all current `active_seconds` attributed to Codex).
- Human-time rules use wall-clock union of any app working: the 50-minute break reminder, "Active today" on Home, and the daily bonus's 10-minute threshold (so two apps do not unlock it twice as fast). The bonus is awarded once per day, from either app. Per-app active time is shown separately on the Usage page.
- Save version stays 1; migrations are additive `setdefault`s, as in 0.1.3.

### Claude state mapping

| Claude signal | Shared state / event |
|---|---|
| `UserPromptSubmit` | working |
| `transcript_path` grows | heartbeat (keeps `last_seen` fresh; 120 s silence rule unchanged) |
| `PreToolUse` `AskUserQuestion` | `input_needed` with question/options preview |
| `Notification` `permission_prompt` / `elicitation_dialog` / `agent_needs_input` | `input_needed`, line "Your move, Trainer! Claude needs permission" |
| `PostToolUse` `AskUserQuestion`, transcript growth after a permission prompt, next `UserPromptSubmit` | waiting cleared → working |
| `Stop` | `completed`; preview from transcript tail when previews are on |
| `StopFailure`, `SessionEnd` during a turn | `stopped` |
| status-line `rate_limits` | allowance; `low_allowance` at 20 / 10 %, `limit_reached` at 0 %, once per window reset |
| transcript `quotaLimits` refusal, read after `Stop` / `StopFailure` | that window at 0 % until `resetsAt`, then cleared; `limit_reached` once, never for a refusal older than launch |
| `idle_prompt` | ignored (already completed) |

### Messages

- `lore.js` lines are shared; event lines may name the app where it carries meaning ("Claude needs permission").
- Pokégear notices and Recent activity show a small app tag. The buddy bubble is untagged unless both apps have pending input: "Your move, Trainer! (Codex + Claude)".
- Reactions and sprite actions are identical for both apps (`action-state.js` unchanged apart from new kinds already present).
- Pokédex detail shows time together per app.

## 4. UI

- **Allowance strip** at the top of Home: one card per app with 5-hour % left (large), weekly % and reset time (small), status dot (working / waiting / idle). Not connected → **Connect** button. Connected without data → reason, e.g. "Terminal sessions share this live. The Claude app only shows a limit once you hit it." Stale → "Stale · 3 h ago". No invented zeros.
- **Usage** page: per-app tokens (input / output / cached) and active time today; Recent activity with app tags.
- **Tray tooltip**: `Pocodex · Codex 77% · Claude 41% left` (only observed values).
- **Buddy caption**: shows allowance only when an observed window is below 20 %.
- Visual language follows the existing Pokédex styling; no new colours beyond one tag colour per app.

## 5. Failure handling

- Inbox: the adapter tracks its read offset; after consumption the file is truncated when above 1 MB. Malformed lines are skipped and counted in source status.
- Missing or stale `claude-limits.json`: allowance card shows the not-observable or stale state.
- Hook binary missing or moved: self-heal on launch; uninstall disconnects.
- Settings file changed concurrently: re-read before write; on conflict retry once, then report.
- A Claude session whose `SessionEnd` never arrives: existing 120-second silence → unknown, no XP.

## 6. Testing

- Unit (Python): Claude adapter against fixture inbox, limits and transcript files; settings editor round trips (connect/disconnect idempotent, unknown keys preserved, status-line wrap and restore, unreadable file untouched, self-heal path rewrite); engine per-app credit, migration, no double credit, union-based break reminder; telemetry merge.
- Unit (Node): lore lines with app tags; allowance strip formatting helpers.
- Desktop (Playwright, isolated profiles and an isolated `CLAUDE_CONFIG_DIR`): connect card detection and consent; both apps pending at once; allowance strip including not-observable and stale states; disconnect restores settings.
- Performance: hook start-up budget measured in the build; idle CPU and memory rechecked with `scripts/measure_pocodex.cjs`.
- Real integration: one Codex run and one real Claude Code run with hooks installed, each sending a single short prompt.

## Release

Version 0.2.0. README, testing notes and third-party notices describe both apps.
