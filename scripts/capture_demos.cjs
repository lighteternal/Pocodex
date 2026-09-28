/** Capture actual app windows with synthetic data; never capture the desktop. */
const { _electron: electron } = require('../companion/node_modules/@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'docs/images');
const fps = 8;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, Math.max(0, milliseconds)));

async function record(page, folder, seconds, actions = {}) {
  await fs.mkdir(folder, { recursive: true });
  const started = performance.now();
  for (let frame = 0; frame < seconds * fps; frame++) {
    await delay(started + frame * 1000 / fps - performance.now());
    if (actions[frame]) await actions[frame]();
    await page.screenshot({ path: path.join(folder, `frame${String(frame).padStart(3, '0')}.png`) });
  }
}

function encode(folder, filename) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(fps),
    '-i', path.join(folder, 'frame%03d.png'), '-filter_complex',
    '[0:v]split[a][b];[a]palettegen=reserve_transparent=1:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:alpha_threshold=128',
    '-loop', '0', path.join(output, filename)], { windowsHide: true, stdio: 'inherit' });
}

(async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pocodex-demo-'));
  const profile = path.join(temporary, 'profile');
  const source = path.join(temporary, 'source');
  const claude = path.join(temporary, 'claude');
  await fs.mkdir(claude, { recursive: true });
  await fs.mkdir(path.join(source, 'sessions'), { recursive: true });
  await fs.mkdir(output, { recursive: true });
  const eventFile = path.join(source, 'sessions/demo.jsonl');
  await fs.writeFile(eventFile, JSON.stringify({ type: 'session_meta', payload: { id: 'demo-chat', originator: 'Codex Desktop', cwd: 'C:/demo/project' } }) + '\n');
  execFileSync(path.join(root, '.venv/Scripts/python.exe'), [path.join(root, 'tests/seed_pocodex_demo.py'), profile, path.join(root, 'companion/assets')], { windowsHide: true });
  const app = await electron.launch({ args: [path.join(root, 'companion'), '--show-home', `--profile=${profile}`, `--source=${source}`, `--claude-config=${claude}`] });
  try {
    let home;
    for (let attempt = 0; attempt < 100 && !home; attempt++) {
      home = app.windows().find(window => window.url().includes('view=home'));
      if (!home) await delay(100);
    }
    if (!home) throw new Error('Pocodex Home did not open for the demo');
    const buddy = app.windows().find(window => window.url().includes('view=buddy'));
    await home.getByRole('heading', { name: 'Ivysaur', exact: true }).waitFor();
    await home.evaluate(() => window.pocodex.command('settings', { sound: false, background: 'forest', reduced_motion: false }));
    const event = (type, payload) => fs.appendFile(eventFile, JSON.stringify({ type, timestamp: new Date().toISOString(), payload }) + '\n');
    // Demo allowance for both apps, observed through the same files the real integrations write.
    await home.evaluate(() => window.pocodex.command('connect', { app: 'claude', enabled: true }));
    const now = Date.now() / 1000;
    await fs.writeFile(path.join(profile, 'claude-limits.json'), JSON.stringify({ at: now, rate_limits: { five_hour: { used_percentage: 64, resets_at: now + 5400 }, seven_day: { used_percentage: 31, resets_at: now + 4 * 86400 } } }));
    await event('event_msg', { type: 'token_count', rate_limits: { primary: { used_percent: 23, window_minutes: 300, resets_at: now + 3000 }, secondary: { used_percent: 58, window_minutes: 10080, resets_at: now + 2 * 86400 } } });
    await home.locator('.hp-box[data-app="claude"][data-state="ok"]').waitFor();
    await home.locator('.hp-box[data-app="codex"][data-state="ok"]').waitFor();
    await home.screenshot({ path: path.join(output, 'home.png') });
    const buddyFrames = path.join(temporary, 'buddy');
    await record(buddy, buddyFrames, 9, {
      12: () => event('event_msg', { type: 'task_started', turn_id: 'demo-turn' }),
      20: () => buddy.waitForFunction(() => document.body.dataset.activity === 'working', null, { timeout: 2500 }),
      28: () => event('response_item', { type: 'function_call', name: 'request_user_input', call_id: 'demo-input', arguments: '{}' }),
      36: () => buddy.waitForFunction(() => document.body.dataset.activity === 'waiting', null, { timeout: 2500 }),
      44: () => event('response_item', { type: 'function_call_output', call_id: 'demo-input', output: '{}' }),
      52: () => event('event_msg', { type: 'task_complete', turn_id: 'demo-turn' }),
      64: () => buddy.getByText(/Ready to review/).first().waitFor({ timeout: 2500 }),
    });
    encode(buddyFrames, 'buddy-events.gif');
    await home.getByRole('button', { name: 'Pokédex', exact: true }).click();
    const dexFrames = path.join(temporary, 'pokedex');
    await record(home, dexFrames, 6, {
      16: () => home.locator('[data-dex="4"]').click(),
      32: () => home.locator('[data-dex="7"]').click(),
    });
    encode(dexFrames, 'pokedex-browse.gif');
    await home.getByRole('button', { name: 'Settings', exact: true }).click();
    // A wild battle, recorded from the real scene: entrance, one move, then Auto to the end.
    await home.getByRole('button', { name: 'Buddy', exact: true }).click();
    await home.getByRole('button', { name: 'Look for wild Pokémon' }).click();
    const battleFrames = path.join(temporary, 'battle');
    // One crop for every frame: the battle screen and its text box, whatever menu shows below.
    await home.locator('.battle-text').waitFor();
    const clip = await home.evaluate(() => {
      const top = document.querySelector('.battle').getBoundingClientRect(), text = document.querySelector('.battle-text').getBoundingClientRect();
      return { x: Math.round(top.x), y: Math.round(top.y), width: Math.round(top.width), height: Math.round(text.bottom - top.y + 8) };
    });
    await record({ screenshot: options => home.screenshot({ ...options, clip }) }, battleFrames, 12, {
      36: () => home.getByRole('button', { name: 'Fight' }).click().then(() => home.locator('[data-battle="move"]').first().click()).catch(() => {}),
      76: () => home.locator('[data-battle="auto"]').click().catch(() => {}),
    });
    encode(battleFrames, 'battle.gif');
    while (!await home.locator('[data-battle="close"]').count()) {
      await home.locator('[data-battle="auto"]').click({ timeout: 60000 }).catch(() => {});
      await home.waitForSelector('[data-battle="fight"], [data-battle="close"]', { timeout: 60000 });
    }
    await home.getByRole('button', { name: 'Continue' }).click();
    await home.getByRole('button', { name: 'Pokédex', exact: true }).click();
    await home.getByRole('button', { name: /Trainer Card/ }).click();
    // The Trainer Card flips to its milestones and back.
    const cardBox = await home.locator('[data-card]').boundingBox();
    const cardFrames = path.join(temporary, 'card');
    await record({ screenshot: options => home.screenshot({ ...options, clip: cardBox }) }, cardFrames, 5, {
      8: () => home.locator('[data-card-action="flip"]').click(),
      26: () => home.locator('[data-card-action="flip"]').click(),
    });
    encode(cardFrames, 'trainer-card.gif');
    // Squirtle is past Wartortle's level: switch to it and evolve, from the dialog to the new form.
    const squirtle = await home.evaluate(() => state.collection.find(p => p.species_id === 7).id);
    await home.evaluate(id => window.pocodex.command('switch', { id }), squirtle);
    await home.getByRole('button', { name: 'Buddy', exact: true }).click();
    await home.locator('[data-evolution="8"]').click();
    await home.evaluate(() => window.scrollTo(0, 0));  // the transformation plays in the field at the top
    const evolveFrames = path.join(temporary, 'evolve');
    const evolveBox = await home.evaluate(() => ({ x: 0, y: 0, width: innerWidth, height: Math.round(document.querySelector('.name-row').getBoundingClientRect().bottom + 16) }));
    await record({ screenshot: options => home.screenshot({ ...options, clip: evolveBox }) }, evolveFrames, 8, {
      8: () => home.locator('[data-confirm-evolution="8"]').click(),
      12: () => home.evaluate(() => window.scrollTo(0, 0)),
    });
    encode(evolveFrames, 'evolution.gif');
    // Professor Tibo's intro, replayed from Settings: hello, his name, Nidorino's send-out, the egg.
    await home.getByRole('button', { name: 'Settings', exact: true }).click();
    await home.getByRole('button', { name: "Replay Professor Tibo's intro" }).click();
    const introFrames = path.join(temporary, 'intro');
    const next = () => home.locator('.intro-box').click();
    const introBox = await home.evaluate(() => ({ x: 0, y: 0, width: innerWidth, height: Math.round(document.querySelector('.intro-box').getBoundingClientRect().bottom + 14) }));
    await record({ screenshot: options => home.screenshot({ ...options, clip: introBox }) }, introFrames, 14, { 20: next, 40: next, 74: next });
    encode(introFrames, 'intro.gif');
    console.log('Captured 6 GIFs and the Home thumbnail from isolated demo data.');
  } finally { await app.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
