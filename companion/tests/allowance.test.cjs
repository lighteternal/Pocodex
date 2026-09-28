const { test } = require('node:test');
const assert = require('node:assert/strict');
const allowance = require('../ui/allowance.js');

const now = Date.UTC(2026, 8, 28, 10, 0) / 1000;
const window = (label, remaining, extra = {}) => ({ label, remaining, resets_at: now + 3600, stale: false, at: now, ...extra });
const on = { codex: { enabled: true, found: true }, claude: { enabled: true, found: true, status_line: true } };
const apps = (codex, claude = { connected: false }) => ({ codex: { connected: true, activity: 'working', ...codex }, claude });

test('observed windows become an HP bar with the week underneath', () => {
  const card = allowance.card('codex', apps({ quota: [window('5h', 77), window('weekly', 62, { resets_at: now + 3 * 86400 })] }), on, now);
  assert.equal(card.state, 'ok');
  assert.deepEqual([card.hp, card.week, card.tone], [77, 62, 'high']);
  assert.match(card.reset, /\d\d:\d\d/);
  assert.equal(card.activity, 'working');
});

test('HP colours follow the games: green above half, yellow to a fifth, red below', () => {
  const tone = left => allowance.card('codex', apps({ quota: [window('5h', left)] }), on, now).tone;
  assert.deepEqual([tone(51), tone(50), tone(21), tone(20), tone(0)], ['high', 'mid', 'mid', 'low', 'out']);
});

test('no data is explained and never drawn as an empty bar', () => {
  const codex = allowance.card('codex', apps({ quota: [] }), on, now);
  assert.equal(codex.state, 'missing');
  assert.equal(codex.hp, undefined);
  assert.match(codex.note, /Codex reply/);
  const claude = allowance.card('claude', apps({}, { connected: true, activity: 'idle', quota: [] }), on, now);
  assert.match(claude.note, /Terminal sessions/);
  const noLine = allowance.card('claude', apps({}, { connected: true, activity: 'idle', quota: [] }), { claude: { enabled: true, status_line: false } }, now);
  assert.match(noLine.note, /status line/);
});

test('stale snapshots keep their number and say how old they are', () => {
  const card = allowance.card('codex', apps({ quota: [window('5h', 50, { stale: true, at: now - 3 * 3600, resets_at: now - 10 })] }), on, now);
  assert.equal(card.state, 'stale');
  assert.equal(card.hp, 50);
  assert.equal(card.note, 'Last seen 3 h ago');
});

test('apps that are off offer to connect only when found', () => {
  const found = allowance.card('claude', apps({}), { claude: { enabled: false, found: true } }, now);
  const missing = allowance.card('claude', apps({}), { claude: { enabled: false, found: false } }, now);
  assert.deepEqual([found.state, found.found, missing.found], ['off', true, false]);
});

test('the buddy only mentions allowance when a current window is low', () => {
  const low = apps({ quota: [window('5h', 12)] }, { connected: true, quota: [window('5h', 60)] });
  assert.equal(allowance.warning(low), 'Codex 5 h: 12% left');
  assert.equal(allowance.warning(apps({ quota: [window('5h', 12, { stale: true })] })), '');
  assert.equal(allowance.warning(apps({ quota: [window('5h', 40)] })), '');
});

test('without a status line, the Claude box says where its numbers can come from', () => {
  const card = allowance.card('claude', { claude: { connected: true, activity: 'idle', quota: [] } }, { claude: { enabled: true, found: true } }, 1000);
  assert.equal(card.state, 'missing');
  assert.match(card.note, /Terminal sessions share this live/);
  assert.match(card.note, /usage check in Settings/);
  const checking = allowance.card('claude', { claude: { connected: true, activity: 'idle', quota: [] } }, { claude: { enabled: true, found: true, usage_check: { enabled: true, problem: null } } }, 1000);
  assert.equal(checking.note, 'Asking Claude Code for its usage.');
  const failing = allowance.card('claude', { claude: { connected: true, activity: 'idle', quota: [] } }, { claude: { enabled: true, found: true, usage_check: { enabled: true, problem: "Claude Code isn't signed in on this PC." } } }, 1000);
  assert.match(failing.note, /isn't signed in/);
});

test('a hit limit reads as an empty box with its reset time', () => {
  const now = 1790589600, quota = [{ label: '5h', remaining: 0, resets_at: now + 5400, at: now - 60, stale: false, source: 'Claude Code usage limit' }];
  const card = allowance.card('claude', { claude: { connected: true, activity: 'idle', quota } }, { claude: { enabled: true, found: true } }, now);
  assert.deepEqual([card.state, card.hp, card.tone, Boolean(card.reset)], ['ok', 0, 'out', true]);
});
