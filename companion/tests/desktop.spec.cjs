const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

let application, home, temporary, source, profileOverride;
function launch(showHome = true) {
  return electron.launch({
    ...(process.env.POCODEX_EXECUTABLE ? { executablePath: process.env.POCODEX_EXECUTABLE } : {}),
    ...(process.env.POCODEX_EXECUTABLE ? { env: { ...process.env, PATH: `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`, Path: `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}` } } : {}),
    args: [...(process.env.POCODEX_EXECUTABLE ? [] : [path.join(__dirname, '..')]), '--preview', ...(showHome ? ['--show-home'] : []), `--profile=${profileOverride || path.join(temporary, 'profile')}`, `--source=${source}`, `--claude-config=${path.join(temporary, 'claude-home')}`, `--claude-cli=${path.join(__dirname, 'fixtures', 'fake-claude.cmd')}`],
  });
}
// Skip Professor Tibo's story, keep the ticked apps and the default name, and start with an egg.
async function finishIntro(page = home) {
  const skip = page.getByRole('button', { name: 'Skip intro' });
  if (await skip.count()) await skip.click();
  await page.locator('[data-intro="connect"]').click();
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  await page.getByRole('button', { name: 'Start with an egg' }).click();
}
async function seedCollection(partner = null) {
  await application.close();
  profileOverride = path.join(temporary, 'collection-profile');
  execFileSync(path.join(__dirname, '../../.venv/Scripts/python.exe'), [path.join(__dirname, '../../tests/seed_pocodex_demo.py'), profileOverride, path.join(__dirname, '../assets'), ...(partner ? [`--partner=${partner}`] : [])]);
  application = await launch();
  if (process.env.POCODEX_EXECUTABLE) expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
  await expect.poll(() => application.windows().length).toBe(2);
  home = application.windows().find(w => w.url().includes('view=home'));
  if (partner) await expect.poll(() => home.evaluate(() => state?.active?.species.id)).toBe(partner);
  else await expect(home.getByRole('heading', { name: 'Ivysaur', exact: true })).toBeVisible();
}
async function capture(page, filename) {
  await page.waitForFunction(() => [...document.images].filter(img => {
    const box = img.getBoundingClientRect();
    return box.bottom > 0 && box.top < innerHeight;
  }).every(img => img.complete && img.naturalWidth > 0));
  await page.waitForFunction(() => [...document.querySelectorAll('[data-shared-effect], [data-sprite-motion]')].every(el => el.dataset.ready === 'true'));
  await page.screenshot({ path: path.join(__dirname, '../../artifacts', filename) });
}
test.beforeEach(async () => {
  profileOverride = null;
  await expect(async () => { await fs.access(path.join(__dirname, '../main.cjs')); }).toPass({ timeout: 500 });
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pocodex-ui-'));
  source = path.join(temporary, 'codex');
  await fs.mkdir(path.join(source, 'sessions'), { recursive: true });
  await fs.writeFile(path.join(source, 'sessions', 'live.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: 'ui-thread', originator: 'Codex Desktop', cwd: 'C:/fixture/project' } }) + '\n');
  application = await launch();
  await expect.poll(() => application.windows().length).toBe(2);
  home = application.windows().find(w => w.url().includes('view=home'));
  await expect(home.getByRole('img', { name: 'Professor Tibo' })).toBeVisible();
});
test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus && home && !home.isClosed()) {
    await home.screenshot({ path: info.outputPath('home-failure.png') });
    console.log('UI diagnostics', await home.evaluate(() => ({ error: document.querySelector('#error')?.textContent, sound: state?.settings, attention: state?.telemetry.attention.map(e => e.kind), audio: audio ? { error: audio.error?.message, ready: audio.readyState, paused: audio.paused, source: audio.src } : null })));
    const buddy = application.windows().find(w => w.url().includes('view=buddy'));
    if (buddy) console.log('Buddy diagnostics', await buddy.evaluate(async () => ({ error: document.querySelector('#error')?.textContent, decoder: typeof ImageDecoder, secure: isSecureContext, fetch: await fetch('pocodex://app/assets/2-sprite.gif').then(r => r.status).catch(e => e.message) })));
  }
  if (application) await application.close();
});

test('first run, sound, collection, settings, keyboard and missing data states', async () => {
  // The source folder exists and the isolated Claude folder does not: only Codex can be chosen.
  await home.getByRole('button', { name: 'Skip intro' }).click();
  await expect(home.getByLabel('Codex', { exact: true })).toBeChecked();
  await expect(home.getByLabel('Claude Code', { exact: true })).toBeDisabled();
  await expect(home.getByLabel('Claude Code', { exact: true })).not.toBeChecked();
  await finishIntro();
  await expect(home.getByText('Two active minutes to hatch')).toBeVisible();
  await home.getByRole('button', { name: 'Mute sound', exact: true }).click();
  await expect(home.getByRole('button', { name: 'Enable sound', exact: true })).toBeVisible();
  await home.getByRole('button', { name: 'Pokédex', exact: true }).click();
  await expect(home.getByRole('heading', { name: 'Your Pokédex' })).toBeVisible();
  await expect(home.getByText('0 owned', { exact: true })).toBeVisible();
  await home.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(home.getByText(/Codex's native approval dialogs are not observable/)).toBeVisible();
  await expect(home.getByText('Not found on this PC', { exact: true })).toBeVisible();
  await expect(home.getByLabel('Show message previews')).toBeChecked();
  await expect(home.getByLabel('Show updates automatically')).toBeChecked();
  await home.getByLabel('Reduce motion').check();
  await home.getByRole('button', { name: 'Usage', exact: true }).click();
  await expect(home.locator('.hp-box[data-app="codex"]')).toHaveAttribute('data-state', 'missing');
  await expect(home.locator('.hp-box[data-app="claude"]')).toHaveAttribute('data-state', 'off');
  await expect(home.locator('.hp-box[data-app="claude"] button')).toHaveCount(0);
  const security = await home.evaluate(() => ({ node: typeof require, bridge: typeof window.pocodex, scripts: [...document.scripts].every(s => !s.src || s.src.startsWith('pocodex:')) }));
  expect(security).toEqual({ node: 'undefined', bridge: 'object', scripts: true });
  await home.screenshot({ path: path.join(__dirname, '../../artifacts/pocodex-empty-usage.png') });
});

test('Professor Tibo walks a new Trainer through Pocodex and can be replayed', async () => {
  const text = home.locator('[data-intro-text]');
  const next = home.getByRole('button', { name: 'Next', exact: true });
  await expect(home.locator('.intro-box')).toContainText('Hello there! Welcome to the world of Pocodex!');
  // Tibo is Pocodex's own pixel art, drawn with a transparent backdrop: his pixels are opaque, the corner is not.
  await expect.poll(() => home.evaluate(() => {
    const canvas = document.querySelector('[data-intro-professor]'), pixels = canvas.getContext('2d').getImageData(0, 0, 64, 96).data;
    let opaque = 0; for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) opaque++;
    return { corner: pixels[3], some: opaque > 1000 };
  })).toEqual({ corner: 0, some: true });
  // The first press finishes the sentence; the next one moves on, as in the games.
  await next.focus();
  await home.keyboard.press('Enter');
  await expect(text).toHaveText('Hello there! Welcome to the world of Pocodex!');
  await home.keyboard.press('Enter');
  await expect(text).toContainText('My name is Tibo');
  const advanceTo = async step => { while (await home.locator('.intro-stage').getAttribute('data-step') !== String(step)) await home.locator('.intro-box').click(); };
  await advanceTo(2);
  await expect(home.locator('.intro-stage')).toHaveAttribute('data-scene', 'pokemon');
  await expect(home.locator('.intro-prop .sprite')).toHaveAttribute('alt', 'Nidorino');
  await advanceTo(6);
  await expect(home.locator('.intro-stage')).toHaveAttribute('data-scene', 'hp');
  await expect(home.locator('.intro-hp-stack')).toHaveAttribute('aria-hidden', 'true');  // illustrative numbers
  await advanceTo(8);
  await expect(home.locator('.intro-stage')).toHaveAttribute('data-scene', 'connect');
  await expect(home.getByRole('button', { name: 'Skip intro' })).toHaveCount(0);
  // The text box never skips choosing apps.
  await home.locator('.intro-box').click();
  await home.locator('.intro-box').click();
  await expect(home.locator('.intro-stage')).toHaveAttribute('data-scene', 'connect');
  await home.locator('[data-intro="connect"]').click();
  await expect(home.getByLabel('Your name')).toBeFocused();
  await home.getByLabel('Your name').fill('   ');
  await home.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(home.locator('.intro-stage')).toHaveAttribute('data-scene', 'farewell');
  await expect(text).toContainText('So your name is Trainer!');  // a blank name keeps the default
  await home.locator('.intro-box').click();
  await home.getByRole('button', { name: 'Start with an egg' }).click();
  await expect(home.getByText('Two active minutes to hatch')).toBeVisible();
  expect(await home.evaluate(() => state.settings.onboarding)).toBe(true);
  // Replaying from Settings changes nothing unless you do: a new name here is saved.
  await home.getByRole('button', { name: 'Settings', exact: true }).click();
  await home.getByRole('button', { name: "Replay Professor Tibo's intro" }).click();
  await expect(home.locator('.intro-stage')).toHaveAttribute('data-scene', 'professor');
  await home.getByRole('button', { name: 'Skip intro' }).click();
  await home.locator('[data-intro="connect"]').click();
  await home.getByLabel('Your name').fill('Red');
  await home.getByLabel('Your name').press('Enter');
  await expect(text).toContainText('So your name is Red!');
  await home.getByRole('button', { name: 'Back to Pocodex' }).click();
  await expect(home.getByText('Two active minutes to hatch')).toBeVisible();
  expect(await home.evaluate(() => state.trainer.name)).toBe('Red');
});

test('keep-on-top keeps the egg above apps when Home is minimized and after restart', async () => {
  await finishIntro();
  await home.getByRole('button', { name: 'Settings', exact: true }).click();
  await home.getByLabel('Keep buddy on top').check();
  const buddyStatus = () => application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=buddy'));
    return window ? { visible: window.isVisible(), top: window.isAlwaysOnTop() } : null;
  });
  await expect.poll(buddyStatus).toEqual({ visible: true, top: true });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=home')).minimize());
  await expect.poll(buddyStatus).toEqual({ visible: true, top: true });
  const buddy = application.windows().find(w => w.url().includes('view=buddy'));
  await expect(buddy.getByRole('img', { name: 'An unhatched egg' })).toBeVisible();
  await application.close();
  application = await launch();
  await expect.poll(buddyStatus).toEqual({ visible: true, top: true });
  await expect.poll(() => application.windows().filter(w => w.url().includes('view=home')).length).toBe(1);
  home = application.windows().find(w => w.url().includes('view=home'));
  await home.getByRole('button', { name: 'Settings', exact: true }).click();
  await home.getByLabel('Keep buddy on top').uncheck();
  await expect.poll(buddyStatus).toEqual({ visible: true, top: false });
});

test('real file events drive working, waiting, completion and duplicate suppression', async () => {
  await finishIntro();
  await home.evaluate(() => window.pocodex.command('settings', { message_previews: false }));
  async function append(type, payload) {
    await fs.appendFile(path.join(source, 'sessions', 'live.jsonl'), JSON.stringify({ type, timestamp: new Date().toISOString(), payload }) + '\n');
  }
  await append('event_msg', { type: 'task_started', turn_id: 'live-turn' });
  await expect(home.locator('body')).toHaveAttribute('data-activity', 'working');
  await append('response_item', { type: 'function_call', name: 'request_user_input', call_id: 'question', arguments: 'PRIVATE SHOULD NOT APPEAR' });
  await expect(home.locator('body')).toHaveAttribute('data-activity', 'waiting');
  await append('response_item', { type: 'function_call_output', call_id: 'question', output: 'PRIVATE ANSWER' });
  await expect(home.locator('body')).toHaveAttribute('data-activity', 'working');
  await append('event_msg', { type: 'task_complete', turn_id: 'live-turn', last_agent_message: 'PRIVATE RESPONSE' });
  await expect(home.getByText('Ready to review', { exact: true }).first()).toBeVisible();
  await expect(home.locator('body')).not.toContainText('PRIVATE');
  await append('event_msg', { type: 'task_complete', turn_id: 'live-turn' });
  await expect(home.locator('.attention-card')).toHaveCount(1);
  await home.screenshot({ path: path.join(__dirname, '../../artifacts/pocodex-live-events.png') });
});

test('populated Pokédex shows dated unlocks, levels and earlier evolution forms', async () => {
  await seedCollection();
  await capture(home, 'pocodex-buddy-home.png');
  const buddy = application.windows().find(w => w.url().includes('view=buddy'));
  await buddy.screenshot({ path: path.join(__dirname, '../../artifacts/pocodex-desktop-buddy.png'), omitBackground: true });
  await home.getByRole('button', { name: 'Pokédex', exact: true }).click();
  await expect(home.getByText('5 owned', { exact: true })).toBeVisible();
  await expect(home.locator('.dex-detail')).toContainText('Ivysaur');
  await capture(home, 'pocodex-collection-selected.png');
  await expect(home.locator('.dex-card')).toHaveCount(5);
  await home.getByRole('button', { name: /Bulbasaur, level/ }).click();
  await expect(home.getByText(/Owned since/)).toBeVisible();
  await home.locator('.dex-history summary').click();
  await expect(home.getByText(/Earlier form/)).toBeVisible();
  await capture(home, 'pocodex-pokedex-history.png');
  await home.getByRole('button', { name: 'Close Pokémon details' }).click();
  await capture(home, 'pocodex-pokedex-grid.png');
});

test('keyboard focus survives live updates and evolution dialog contains focus', async () => {
  await seedCollection();
  await home.getByRole('button', { name: 'Pokédex', exact: true }).click();
  await home.getByRole('searchbox').fill('Squirtle');
  await home.getByRole('button', { name: /Squirtle, level/ }).click();
  await home.getByRole('button', { name: 'Take along', exact: true }).first().click();
  await home.getByRole('button', { name: 'Evolve', exact: true }).click();
  await expect(home.getByRole('dialog')).toBeVisible();
  await home.getByRole('button', { name: 'Later', exact: true }).focus();
  await home.keyboard.press('Shift+Tab');
  await expect(home.getByRole('dialog').getByRole('button', { name: 'Evolve', exact: true })).toBeFocused();
  await home.keyboard.press('Tab');
  await expect(home.getByRole('button', { name: 'Later', exact: true })).toBeFocused();
  await fs.appendFile(path.join(source, 'sessions/live.jsonl'), JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_started', turn_id: 'focus-turn' } }) + '\n');
  await expect(home.locator('body')).toHaveAttribute('data-activity', 'working');
  await expect(home.getByRole('button', { name: 'Later', exact: true })).toBeFocused();
  await home.screenshot({ path: path.join(__dirname, '../../artifacts/pocodex-evolution-dialog.png') });
  await home.getByRole('dialog').getByRole('button', { name: 'Evolve', exact: true }).click();
  await expect(home.getByRole('heading', { name: 'Wartortle', exact: true })).toBeVisible();
  await expect(home.getByRole('dialog')).toHaveCount(0);
});

test('small window keeps navigation reachable and explains an empty search', async () => {
  await seedCollection();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=home')).setSize(360, 520));
  await home.getByRole('button', { name: 'Pokédex', exact: true }).click();
  await home.getByRole('searchbox').fill('zzznomatch');
  await expect(home.getByText('No Pokémon match')).toBeVisible();
  await home.getByRole('searchbox').fill('');
  await home.locator('h2').filter({ hasText: 'Special encounters' }).scrollIntoViewIfNeeded();
  await expect(home.getByRole('button', { name: 'Buddy', exact: true })).toBeInViewport();
  await home.getByRole('button', { name: 'Buddy', exact: true }).click();
  await expect(home.getByRole('heading', { name: 'Ivysaur', exact: true })).toBeInViewport();
  expect(await home.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await home.screenshot({ path: path.join(__dirname, '../../artifacts/pocodex-small-window.png') });
});

test('buddy opens Home, sound decodes, mute stops playback and settings survive restart', async () => {
  await seedCollection();
  const buddy = application.windows().find(w => w.url().includes('view=buddy'));
  await home.getByRole('button', { name: /Back to work/ }).click();
  await expect.poll(() => application.windows().length).toBe(1);
  await buddy.getByRole('button', { name: 'Open Pocodex' }).click();
  await expect.poll(() => application.windows().length).toBe(2);
  home = application.windows().find(w => w.url().includes('view=home'));
  await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=home')).isVisible())).toBe(true);
  await home.getByRole('button', { name: 'Settings', exact: true }).click();
  await home.getByLabel('Play Pokémon cries').check();
  await expect(home.getByRole('button', { name: 'Mute sound', exact: true })).toBeVisible();
  await home.getByRole('button', { name: 'Preview cry' }).click();
  await expect.poll(() => home.evaluate(() => Boolean(audio && audio.readyState >= 2 && !audio.error))).toBe(true);
  await home.getByRole('button', { name: 'Mute sound', exact: true }).click();
  expect(await home.evaluate(() => audio.paused)).toBe(true);
  await home.getByLabel('Reduce motion').check();
  await expect(home.locator('body')).toHaveClass(/reduced-motion/);
  await application.close();
  application = await launch();
  await expect.poll(() => application.windows().length).toBe(2);
  home = application.windows().find(w => w.url().includes('view=home'));
  await expect(home.getByRole('heading', { name: 'Ivysaur', exact: true })).toBeVisible();
  await expect(home.getByRole('button', { name: 'Enable sound', exact: true })).toBeVisible();
  await expect(home.locator('body')).toHaveClass(/reduced-motion/);
  await home.getByRole('button', { name: 'Pokédex', exact: true }).click();
  await expect(home.locator('canvas[data-still-sprite]').first()).toHaveAttribute('data-ready', 'true');
  await expect(home.locator('img.sprite')).toHaveCount(0);
});

test('buddy-only startup and closing Home release its renderer without losing collection or events', async () => {
  await seedCollection();
  await application.close();
  application = await launch(false);
  const buddy = await application.firstWindow();
  await expect(buddy.locator('.buddy-caption')).toContainText('Ivysaur');
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  for (let cycle = 0; cycle < 3; cycle++) {
    await buddy.getByRole('button', { name: 'Open Pocodex' }).click();
    await expect.poll(() => application.windows().length).toBe(2);
    home = application.windows().find(w => w.url().includes('view=home'));
    await expect(home.getByRole('heading', { name: 'Ivysaur', exact: true })).toBeVisible();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=home')).close());
    await expect.poll(() => application.windows().length).toBe(1);
    await expect.poll(() => application.evaluate(({ app }) => app.getAppMetrics().filter(p => p.type === 'Tab').length)).toBe(1);
  }
  await fs.appendFile(path.join(source, 'sessions/live.jsonl'), [
    { type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_started', turn_id: 'background-turn' } },
    { type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_complete', turn_id: 'background-turn' } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  await expect(buddy.locator('.bubble')).toHaveText(/Ready to review/);
  await buddy.getByRole('button', { name: 'Open Pocodex' }).click();
  await expect.poll(() => application.windows().filter(w => w.url().includes('view=home')).length).toBe(1);
  home = application.windows().find(w => w.url().includes('view=home'));
  await expect(home.locator('.attention-card').filter({ hasText: 'Ready to review' })).toHaveCount(1);
  await home.getByRole('button', { name: 'Pokédex', exact: true }).click();
  await expect(home.getByText('5 owned', { exact: true })).toBeVisible();
});

test('desktop buddy has alpha without screenshot overrides and reduced motion holds the action frame', async () => {
  await seedCollection();
  const buddy = application.windows().find(w => w.url().includes('view=buddy'));
  await expect(buddy.locator('canvas[data-sprite-motion]')).toHaveAttribute('data-ready', 'true');
  await home.evaluate(() => window.pocodex.command('settings', { reduced_motion: true }));
  await expect.poll(() => buddy.locator('canvas').evaluate(c => c.dataset.phase)).toBe('rest');
  await expect(buddy.locator('canvas')).toHaveAttribute('data-frame', '0');
  const first = await buddy.locator('canvas').evaluate(c => [...c.getContext('2d').getImageData(0, 0, c.width, c.height).data].reduce((n, v) => (n * 31 + v) >>> 0, 0));
  await home.getByRole('button', { name: 'Usage', exact: true }).click();
  expect(await buddy.locator('canvas').evaluate(c => [...c.getContext('2d').getImageData(0, 0, c.width, c.height).data].reduce((n, v) => (n * 31 + v) >>> 0, 0))).toBe(first);
  const alpha = await application.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=buddy'));
    const image = await window.webContents.capturePage();
    return image.toBitmap()[3];
  });
  expect(alpha).toBe(0);
  await buddy.screenshot({ path: path.join(__dirname, '../../artifacts/pocodex-transparent-buddy.png') });
  const desktop = await application.evaluate(async ({ BrowserWindow, desktopCapturer, screen }) => {
    const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=buddy'));
    const area = screen.getPrimaryDisplay().workArea;
    window.setPosition(area.x + 40, area.y + 80);
    window.setAlwaysOnTop(true);
    window.showInactive();
    const bounds = window.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: display.size.width * display.scaleFactor, height: display.size.height * display.scaleFactor } });
    const source = sources.find(s => s.display_id === String(display.id));
    if (!source) throw new Error('Desktop compositor capture unavailable');
    const sx = source.thumbnail.getSize().width / display.size.width;
    const sy = source.thumbnail.getSize().height / display.size.height;
    return source.thumbnail.crop({ x: Math.round((bounds.x - display.bounds.x) * sx), y: Math.round((bounds.y - display.bounds.y) * sy), width: Math.round(bounds.width * sx), height: Math.round(bounds.height * sy) }).toPNG().toString('base64');
  });
  await fs.writeFile(path.join(__dirname, '../../artifacts/pocodex-desktop-composite.png'), Buffer.from(desktop, 'base64'));
});

test('live work hatches an egg, refreshes choices and preserves the adopted companion', async () => {
  await application.close();
  const eggProfile = path.join(temporary, 'egg-profile');
  execFileSync(path.join(__dirname, '../../.venv/Scripts/python.exe'), [path.join(__dirname, '../../tests/seed_pocodex_demo.py'), eggProfile, path.join(__dirname, '../assets'), '--egg']);
  profileOverride = eggProfile;
  application = await launch();
  await expect.poll(() => application.windows().length).toBe(2);
  home = application.windows().find(w => w.url().includes('view=home'));
  await expect(home.getByRole('heading', { name: 'Your egg', exact: true })).toBeVisible();
  const file = path.join(source, 'sessions/live.jsonl');
  await fs.appendFile(file, JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_started', turn_id: 'hatch' } }) + '\n');
  await expect(home.getByRole('heading', { name: 'Your egg hatched', exact: true })).toBeVisible();
  const choices = await home.locator('[data-adopt]').allTextContents();
  await home.getByRole('button', { name: 'Show another three' }).click();
  await expect.poll(() => home.locator('[data-adopt]').allTextContents()).not.toEqual(choices);
  await capture(home, 'pocodex-hatch-choices.png');
  const chosen = (await home.locator('[data-adopt]').first().textContent()).replace(/^Keep /, '');
  await home.locator('[data-adopt]').first().click();
  await expect(home.getByRole('heading', { name: chosen, exact: true, level: 1 })).toBeVisible();
  await fs.appendFile(file, JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_complete', turn_id: 'hatch' } }) + '\n');
  await expect(home.getByText('Ready to review', { exact: true }).first()).toBeVisible();
  await home.getByRole('button', { name: 'New egg', exact: true }).click();
  await expect(home.getByRole('heading', { name: 'Your egg', exact: true })).toBeVisible();
  // Regression: starting an egg once announced "Oh? Your egg hatched!" and played a cry.
  await expect(home.locator('.field-label')).toHaveText('A fresh Egg from the Day Care!');
  await home.getByRole('button', { name: 'Pokédex', exact: true }).click();
  await expect(home.getByText('1 owned', { exact: true })).toBeVisible();
  await home.locator('.collection-row').getByRole('button', { name: 'Take along' }).first().click();
  await expect(home.getByRole('heading', { name: chosen, exact: true })).toBeVisible();
});

test('every bundled sprite and cry decodes without an external connection', async () => {
  const catalog = JSON.parse(await fs.readFile(path.join(__dirname, '../assets/catalog.json'), 'utf8'));
  const checked = await home.evaluate(async species => {
    let decoded = 0;
      for (const item of species) {
        const data = await fetch(`pocodex://app/assets/${item.sprite}`).then(r => r.arrayBuffer());
        const decoder = new ImageDecoder({ data, type: item.sprite.endsWith('.gif') ? 'image/gif' : 'image/png' });
        try { const frame = await decoder.decode({ frameIndex: 0 }); frame.image.close(); } finally { decoder.close(); }
        await new Promise((resolve, reject) => {
          const sound = new Audio();
          sound.muted = true;
          sound.onloadeddata = () => { sound.removeAttribute('src'); sound.load(); resolve(); };
          sound.onerror = () => reject(new Error(`Cry cannot decode: ${item.cry}`));
          sound.src = `pocodex://assets/${item.cry}`;
          sound.load();
        });
        decoded++;
      }
      return decoded;
  }, catalog.species);
  expect(checked).toBe(catalog.species.length);
  const sheets = await home.evaluate(async () => {
    const pack = await fetch('pocodex://app/assets/actions.json').then(r => r.json());
    const files = pack.manifest.filter(entry => entry.file.endsWith('.png'));
    for (const entry of files) {
      const response = await fetch(`pocodex://app/assets/${entry.file}`);
      if (!response.ok) throw new Error(`Missing action sheet ${entry.file}`);
      const image = await createImageBitmap(await response.blob());
      image.close();
    }
    return files.length;
  });
  // Every PNG the pinned pack lists must decode; the count follows the pack, not a magic number.
  const pinned = JSON.parse(await fs.readFile(path.join(__dirname, '../data/actions.json'), 'utf8')).manifest.filter(entry => entry.file.endsWith('.png')).length;
  expect(sheets).toBe(pinned);
  expect(sheets).toBeGreaterThan(1800);
});

test('damaged profile reports a core failure without replacing the save', async () => {
  await application.close();
  profileOverride = path.join(temporary, 'damaged-profile');
  await fs.mkdir(profileOverride);
  const save = path.join(profileOverride, 'companion.sqlite');
  const damaged = Buffer.from('damaged-test-save-do-not-replace');
  await fs.writeFile(save, damaged);
  application = await launch();
  await expect.poll(() => application.windows().length).toBe(2);
  home = application.windows().find(w => w.url().includes('view=home'));
  await expect(home.getByRole('alert')).toContainText('Local companion stopped');
  expect(await fs.readFile(save)).toEqual(damaged);
});

test('game dialogue font loads offline only for companion messages and fits the buddy', async () => {
  await seedCollection();
  const buddy = application.windows().find(w => w.url().includes('view=buddy'));
  await fs.appendFile(path.join(source, 'sessions/live.jsonl'), [
    { type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_started', turn_id: 'font-turn' } },
    { type: 'response_item', timestamp: new Date().toISOString(), payload: { type: 'function_call', name: 'request_user_input', call_id: 'font-question' } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  await expect(buddy.locator('.bubble')).toHaveText(/Need your input/);
  await expect(buddy.locator('.bubble')).toHaveCSS('font-family', /Pokemon Classic/);
  await expect(home.locator('.attention-card strong').first()).toHaveCSS('font-family', /Pokemon Classic/);
  for (const page of [home, buddy]) expect(await page.evaluate(async () => (await document.fonts.load('8px "Pokemon Classic"')).length)).toBe(1);
  for (const selector of ['nav button', '.name-row h1', '.mini-stats strong']) {
    await expect(home.locator(selector).first()).not.toHaveCSS('font-family', /Pokemon Classic/);
  }
  await expect(buddy.locator('.buddy-caption')).not.toHaveCSS('font-family', /Pokemon Classic/);
  await fs.appendFile(path.join(source, 'sessions/live.jsonl'), JSON.stringify({ type: 'response_item', timestamp: new Date().toISOString(), payload: { type: 'function_call_output', call_id: 'font-question' } }) + '\n');
  await expect(buddy.locator('body')).toHaveAttribute('data-activity', 'working');
  await buddy.evaluate(() => react('Stretch break? Codex has worked for 50 minutes.', 'break_reminder'));
  await expect(buddy.locator('.bubble')).toHaveText('Stretch break? Codex has worked for 50 minutes.');
  const geometry = await buddy.locator('.bubble').evaluate(element => {
    const box = element.getBoundingClientRect();
    return { fits: box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth,
      wraps: element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight };
  });
  await buddy.screenshot({ path: path.join(__dirname, '../../artifacts/pocodex-message-font.png') });
  if (!geometry.fits) console.log('Dialogue bounds', await buddy.evaluate(() => [...document.querySelectorAll('.bubble,.buddy-hit,.buddy-caption')].map(e => ({ element: e.className, bounds: e.getBoundingClientRect().toJSON() }))));
  expect(geometry).toEqual({ fits: true, wraps: true });
  await home.screenshot({ path: path.join(__dirname, '../../artifacts/pocodex-message-font-home.png') });
});

test('transparent scenery choices sync to the buddy and random stays stable across polls', async () => {
  await seedCollection();
  const buddy = application.windows().find(w => w.url().includes('view=buddy'));
  await home.getByRole('button', { name: 'Settings', exact: true }).click();
  for (const scene of ['meadow', 'forest', 'pond', 'beach', 'snow', 'ruins', 'camp', 'volcano']) {
    await home.getByLabel('Sprite scenery').selectOption(scene);
    await expect(buddy.locator('.scenery')).toHaveAttribute('data-scene', scene);
    const alpha = await application.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=buddy')).webContents.capturePage()).toBitmap()[3]);
    expect(alpha).toBe(0);
    await buddy.screenshot({ path: path.join(__dirname, '../../artifacts', `pocodex-scenery-${scene}.png`) });
  }
  await home.getByLabel('Sprite scenery').selectOption('random');
  await expect.poll(() => home.evaluate(() => state.settings.background)).toBe('random');
  const initialRandom = await home.evaluate(() => state.background);
  await expect(buddy.locator('.scenery')).toHaveAttribute('data-scene', initialRandom);
  const selected = await buddy.locator('.scenery').getAttribute('data-scene');
  await home.getByRole('button', { name: 'Shuffle scenery' }).click();
  await expect(buddy.locator('.scenery')).not.toHaveAttribute('data-scene', selected);
  const shuffled = await buddy.locator('.scenery').getAttribute('data-scene');
  await buddy.evaluate(() => window.pocodex.command('snapshot'));
  await expect(buddy.locator('.scenery')).toHaveAttribute('data-scene', shuffled);
  await home.screenshot({ path: path.join(__dirname, '../../artifacts/pocodex-scenery-settings.png') });
  await home.getByLabel('Sprite scenery').selectOption('none');
  await expect(buddy.locator('.scenery')).toHaveCount(0);
});

test('ready alert remains visible and a newer input request takes priority', async () => {
  await seedCollection();
  const buddy = application.windows().find(w => w.url().includes('view=buddy'));
  const file = path.join(source, 'sessions/live.jsonl');
  await fs.appendFile(file, JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_complete', turn_id: 'before-launch' } }) + '\n');
  await expect(buddy.locator('.bubble')).toHaveText(/Ready to review/);
  await expect(buddy.locator('body')).not.toHaveClass(/celebrating/, { timeout: 6000 });
  await expect(buddy.locator('.bubble')).toHaveText(/Ready to review/);
  await fs.appendFile(file, [
    { type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_started', turn_id: 'question-turn' } },
    { type: 'response_item', timestamp: new Date().toISOString(), payload: { type: 'function_call', name: 'request_user_input', call_id: 'ask' } },
  ].map(r => JSON.stringify(r)).join('\n') + '\n');
  await expect(buddy.locator('.bubble')).toHaveText(/Need your input/);
  await expect(buddy.locator('.buddy-caption')).toContainText('Needs you');
});

test('automatic updates preview answers, clear superseded results and resolve async questions', async () => {
  await seedCollection();
  const buddy = application.windows().find(w => w.url().includes('view=buddy'));
  const file = path.join(source, 'sessions/live.jsonl');
  const append = (type, payload) => fs.appendFile(file, JSON.stringify({ type, payload, timestamp: new Date().toISOString() }) + '\n');
  await home.getByRole('button', { name: 'Settings', exact: true }).click();
  await home.getByLabel('Show message previews').check();
  await expect.poll(() => home.evaluate(() => state.settings.message_previews)).toBe(true);
  await home.evaluate(async () => {
    await window.pocodex.command('settings', { break_reminders: false });
    for (const event of state.telemetry.attention) await window.pocodex.command('acknowledge', { id: event.id });
  });
  await append('event_msg', { type: 'task_complete', turn_id: 'answer', last_agent_message: 'Fixed the stale status. <script>bad()</script> Tests passed.' });
  await expect.poll(() => application.windows().filter(w => w.url().includes('view=updates')).length).toBe(1);
  let updates = application.windows().find(w => w.url().includes('view=updates'));
  await expect(updates.getByText('Fixed the stale status. <script>bad()</script> Tests passed.', { exact: true })).toBeVisible();
  const updateSize = await updates.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  expect(updateSize.width).toBeLessThanOrEqual(320);
  expect(updateSize.height).toBeLessThanOrEqual(180);
  expect(await updates.locator('script:not([src])').count()).toBe(0);
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=updates')).isFocused())).toBe(false);
  await updates.screenshot({ path: path.join(__dirname, '../../artifacts/pocodex-answer-update.png') });
  await append('event_msg', { type: 'task_started', turn_id: 'next' });
  await expect(buddy.locator('.buddy-caption')).toContainText('1 working');
  await expect(buddy.locator('.bubble')).not.toHaveText(/Ready to review/);
  await expect.poll(() => application.windows().filter(w => w.url().includes('view=updates')).length).toBe(0);
  await append('response_item', { type: 'function_call', name: 'request_user_input_async', call_id: 'async-ask', arguments: JSON.stringify({ questions: [{ title: 'Which colour should I use?', options: ['Forest green', 'Warm red'] }] }) });
  await expect.poll(() => application.windows().filter(w => w.url().includes('view=updates')).length).toBe(1);
  updates = application.windows().find(w => w.url().includes('view=updates'));
  await expect(updates.getByText('Which colour should I use?', { exact: true })).toBeVisible();
  await expect(updates.getByText('Forest green', { exact: true })).toBeVisible();
  await expect(buddy.locator('.buddy-caption')).toContainText('1 working');
  await append('response_item', { type: 'function_call_output', call_id: 'async-ask', output: '{"accepted":true}' });
  await expect(updates.getByText('Which colour should I use?', { exact: true })).toBeVisible();
  await home.getByLabel('Show message previews').uncheck();
  await expect(updates.getByText('Which colour should I use?', { exact: true })).toHaveCount(0);
  await append('event_msg', { type: 'user_message', message: '<send_user_message_question_reply>' + JSON.stringify([{ questionItemId: '["request_user_input_async","async-ask",0]' }]) + '</send_user_message_question_reply>' });
  await expect.poll(() => application.windows().filter(w => w.url().includes('view=updates')).length).toBe(0);
  await home.getByLabel('Quiet mode').check();
  await append('event_msg', { type: 'task_complete', turn_id: 'next' });
  await expect.poll(() => home.evaluate(() => state.telemetry.attention.filter(e => e.kind === 'completed').length)).toBe(1);
  expect(application.windows().filter(w => w.url().includes('view=updates')).length).toBe(0);
  await home.getByLabel('Quiet mode').uncheck();
  await home.evaluate(() => window.pocodex.command('snapshot'));
  expect(application.windows().filter(w => w.url().includes('view=updates')).length).toBe(0);
  await buddy.evaluate(() => document.querySelector('.buddy-caption').click());
  await expect.poll(() => application.windows().filter(w => w.url().includes('view=updates')).length).toBe(1);
  updates = application.windows().find(w => w.url().includes('view=updates'));
  await expect.poll(() => home.evaluate(() => state.telemetry.attention.length), { timeout: 25000 }).toBe(0);
  await expect.poll(() => application.evaluate(({ app }) => app.getAppMetrics().filter(p => p.type === 'Tab').length)).toBe(2);
});

test('message previews render Markdown without active content', async () => {
  await seedCollection();
  await home.evaluate(() => window.pocodex.command('settings', { break_reminders: false }));
  const answer = '**Pocodex is in your Start menu.**\n\n1. Open **Start**.\n2. Type `Pocodex`.\n\n[Instructions](https://example.com)\n\n<img src=x onerror="window.injected=true">\n\n![remote](https://example.com/track.png)\n\n[bad](javascript:alert(1))\n\n```js\n<script>bad()</script>\n```';
  await fs.appendFile(path.join(source, 'sessions/live.jsonl'), JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'markdown', last_agent_message: answer }, timestamp: new Date().toISOString() }) + '\n');
  await expect.poll(() => application.windows().filter(w => w.url().includes('view=updates')).length).toBe(1);
  const updates = application.windows().find(w => w.url().includes('view=updates'));
  for (const page of [updates, home]) {
    const preview = page.locator('.message-preview');
    await expect(preview.locator('strong').first()).toHaveText('Pocodex is in your Start menu.');
    await expect(preview.locator('ol > li')).toHaveCount(2);
    await expect(preview.locator('li code')).toHaveText('Pocodex');
    await expect(preview.locator('pre code')).toHaveText('<script>bad()</script>\n');
    await expect(preview).toContainText('Instructions');
    expect(await preview.locator('img, script, iframe, a[href], [onerror]').count()).toBe(0);
    expect(await page.evaluate(() => window.injected)).toBeUndefined();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await updates.screenshot({ path: path.join(__dirname, '../../artifacts/pocodex-markdown.png') });
  await updates.getByRole('button', { name: 'Close updates' }).focus();
  await expect(updates.getByRole('button', { name: 'Close updates' })).toBeFocused();
  await updates.keyboard.press('Enter').catch(error => { if (!updates.isClosed()) throw error; });
  await expect.poll(() => application.windows().filter(w => w.url().includes('view=updates')).length).toBe(0);
});

test('closing an answer notice clears its badge and hiding the buddy hides its notice', async () => {
  await seedCollection();
  const file = path.join(source, 'sessions/live.jsonl');
  const complete = turn => fs.appendFile(file, JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_complete', turn_id: turn, last_agent_message: 'All checks passed.' } }) + '\n');
  await complete('dismiss');
  await expect.poll(() => application.windows().filter(w => w.url().includes('view=updates')).length).toBe(1);
  let updates = application.windows().find(w => w.url().includes('view=updates'));
  await updates.evaluate(() => window.pocodex.hideUpdates()).catch(error => { if (!updates.isClosed()) throw error; });
  await expect.poll(() => home.evaluate(() => state.telemetry.attention.filter(e => e.kind === 'completed').length)).toBe(0);
  await complete('hide');
  await expect.poll(() => application.windows().filter(w => w.url().includes('view=updates')).length).toBe(1);
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=buddy')).hide(); });
  await expect.poll(() => application.windows().filter(w => w.url().includes('view=updates')).length).toBe(0);
});

test('close can quit completely and releases the sidecar', async () => {
  await seedCollection();
  await home.getByRole('button', { name: 'Settings', exact: true }).click();
  const mainPid = await application.evaluate(() => process.pid);
  const sidecarPid = Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${mainPid}' | Where-Object { $_.Name -match 'python|pocodex-core' } | Select-Object -First 1 -ExpandProperty ProcessId`], { encoding: 'utf8', windowsHide: true }).trim());
  await home.getByLabel('Close button quits Pocodex completely').check();
  const closed = application.waitForEvent('close');
  await application.evaluate(({ BrowserWindow }) => { setImmediate(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=home')).close()); });
  await closed;
  application = null;
  expect(sidecarPid).toBeGreaterThan(0);
  await expect.poll(() => { try { process.kill(sidecarPid, 0); return true; } catch { return false; } }).toBe(false);
});

test('startup option registers only this profile and Quit completely stops its watcher', async () => {
  await seedCollection();
  const marker = path.join(profileOverride, 'startup-watcher.pid');
  try {
    await home.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(home.getByLabel('Open when the Codex app starts')).toBeEnabled();
    await home.getByLabel('Open when the Codex app starts').check();
    await expect.poll(() => home.evaluate(() => startupState?.enabled)).toBe(true);
    await expect.poll(async () => fs.access(marker).then(() => true, () => false), { timeout: 10000 }).toBe(true);
    const watcherPid = Number(await fs.readFile(marker, 'ascii'));
    const closed = application.waitForEvent('close');
    await home.getByRole('button', { name: 'Quit completely', exact: true }).click();
    await closed;
    application = null;
    await expect.poll(() => { try { process.kill(watcherPid, 0); return true; } catch { return false; } }, { timeout: 10000 }).toBe(false);
    await expect.poll(async () => fs.access(marker).then(() => true, () => false)).toBe(false);
  } finally {
    execFileSync(path.join(__dirname, '../../.venv/Scripts/python.exe'), ['-m', 'observatory.companion.startup', '--profile', profileOverride, '--configure', 'disable'], { cwd: path.join(__dirname, '../..'), windowsHide: true });
  }
});

test('tray opens settings and collection, hides windows and quits the app', async () => {
  await seedCollection();
  // Observe the real native menu without replacing its construction or callbacks.
  await application.evaluate(({ Tray }) => {
    const original = Tray.prototype.setContextMenu;
    Tray.prototype.setContextMenu = function(menu) {
      globalThis.testTray = this;
      globalThis.testTrayMenu = menu;
      return original.call(this, menu);
    };
  });
  await home.evaluate(() => window.pocodex.command('settings', { sound: true }));
  await expect.poll(() => application.evaluate(() => Boolean(globalThis.testTrayMenu))).toBe(true);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=home')).minimize());
  const trayState = await application.evaluate(() => ({ destroyed: globalThis.testTray.isDestroyed(), bounds: globalThis.testTray.getBounds() }));
  expect(trayState.destroyed).toBe(false);
  expect(trayState.bounds.width).toBeGreaterThan(0);
  expect(trayState.bounds.height).toBeGreaterThan(0);
  const click = label => application.evaluate((_, name) => {
    const item = globalThis.testTrayMenu.items.find(entry => entry.label === name);
    if (!item) throw new Error(`Missing tray action: ${name}`);
    item.click();
  }, label);
  await click('Properties / Settings');
  await expect(home.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await click('Pokédex');
  await expect(home.getByRole('heading', { name: 'Your Pokédex' })).toBeVisible();
  await click('Hide buddy');
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=buddy')).isVisible())).toBe(false);
  await click('Show buddy');
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=buddy')).isVisible())).toBe(true);
  await click('Close window');
  await expect.poll(() => home.isClosed()).toBe(true);
  await click('Properties / Settings');
  await expect.poll(() => application.windows().filter(w => w.url().includes('view=home')).length).toBe(1);
  home = application.windows().find(w => w.url().includes('view=home'));
  await expect(home.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  const closed = application.waitForEvent('close');
  await click('Quit completely');
  await closed;
  application = null;
});

test('buddy maps real walking, sleeping and attention sheets without network downloads', async () => {
  await seedCollection();
  const buddy = application.windows().find(w => w.url().includes('view=buddy'));
  await expect(buddy.locator('canvas[data-sprite-motion]')).toHaveAttribute('data-ready', 'true');
  await expect(buddy.locator('canvas[data-sprite-motion]')).toHaveAttribute('data-mood', 'sleeping', { timeout: 20000 });
  await expect(buddy.locator('canvas[data-sprite-motion]')).toHaveAttribute('data-sprite-sheet', '2-action-Sleep.png');
  await capture(buddy, 'pocodex-sleeping.png');
  await fs.appendFile(path.join(source, 'sessions/live.jsonl'), JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_started', turn_id: 'patrol-turn' } }) + '\n');
  await expect(buddy.locator('canvas[data-sprite-motion]')).toHaveAttribute('data-mood', 'walking');
  await expect(buddy.locator('canvas[data-sprite-motion]')).toHaveAttribute('data-sprite-sheet', '2-action-Walk.png');
  await capture(buddy, 'pocodex-working.png');
  await home.evaluate(() => window.pocodex.command('settings', { reduced_motion: true }));
  await expect.poll(() => buddy.locator('canvas[data-sprite-motion]').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  await expect(buddy.locator('canvas[data-sprite-motion]')).toHaveAttribute('data-frame', '0');
  await fs.appendFile(path.join(source, 'sessions/live.jsonl'), JSON.stringify({ type: 'response_item', timestamp: new Date().toISOString(), payload: { type: 'function_call', name: 'request_user_input', call_id: 'sprite-input', arguments: '{}' } }) + '\n');
  await expect(buddy.locator('canvas[data-sprite-motion]')).toHaveAttribute('data-action', 'Idle');
  await expect(buddy.locator('[data-shared-effect="question"]')).toHaveAttribute('data-ready', 'true');
  await capture(buddy, 'pocodex-waiting-sprite.png');
  await home.evaluate(() => window.pocodex.command('settings', { quiet: true }));
  await expect(buddy.locator('[data-shared-effect]')).toHaveCount(0);
});

test('Galarian Ponyta uses its own eating, nodding, celebration and sleep sheets', async () => {
  await seedCollection(10162);  // Galarian Ponyta
  const buddy = application.windows().find(w => w.url().includes('view=buddy'));
  const canvas = buddy.locator('[data-sprite-motion]');
  await home.getByRole('button', { name: /Feed berry/ }).click();
  await expect(canvas).toHaveAttribute('data-sprite-sheet', '10162-action-Eat.png');
  await expect(buddy.locator('[data-shared-effect="berry"]')).toHaveAttribute('data-ready', 'true');
  await capture(buddy, 'pocodex-ponyta-eating.png');
  await home.getByRole('button', { name: /^Pet/ }).click();
  await expect(canvas).toHaveAttribute('data-sprite-sheet', '10162-action-Nod.png');
  await capture(buddy, 'pocodex-ponyta-petting.png');
  const append = (type, payload) => fs.appendFile(path.join(source, 'sessions/live.jsonl'), JSON.stringify({ type, payload, timestamp: new Date().toISOString() }) + '\n');
  await append('event_msg', { type: 'task_started', turn_id: 'ponyta-work' });
  await expect(canvas).toHaveAttribute('data-sprite-sheet', '10162-action-Walk.png');
  await capture(buddy, 'pocodex-ponyta-walking.png');
  await append('event_msg', { type: 'task_complete', turn_id: 'ponyta-work', last_agent_message: 'The action sprites are ready.' });
  await expect(canvas).toHaveAttribute('data-sprite-sheet', '10162-action-Pose.png');
  await expect(buddy.locator('[data-shared-effect="sparkle"]')).toHaveAttribute('data-ready', 'true');
  await capture(buddy, 'pocodex-ponyta-completed.png');
  await append('event_msg', { type: 'task_started', turn_id: 'ponyta-next' });
  await expect(canvas).toHaveAttribute('data-action', 'Walk');
  await expect(buddy.locator('[data-shared-effect="sparkle"]')).toHaveCount(0);
  await append('event_msg', { type: 'task_complete', turn_id: 'ponyta-next' });
  await expect(canvas).toHaveAttribute('data-sprite-sheet', '10162-action-Sleep.png', { timeout: 15000 });
  await expect(buddy.locator('[data-shared-effect]')).toHaveCount(0);
  await capture(buddy, 'pocodex-ponyta-sleeping.png');
  await home.evaluate(() => window.pocodex.command('settings', { reduced_motion: true }));
  await expect(canvas).toHaveAttribute('data-frame', '0');
  expect(await canvas.evaluate(el => el.getContext('2d').getImageData(0, 0, 1, 1).data[3])).toBe(0);
});

test('pets and berries award saved XP and animate on both companion views', async () => {
  await seedCollection();
  const buddy = application.windows().find(w => w.url().includes('view=buddy'));
  const before = await home.evaluate(() => ({ xp: state.active.xp, seconds: state.active.active_seconds }));
  await home.getByRole('button', { name: /Feed berry/ }).click();
  await expect(home.locator('[data-effect="berry"]')).toBeVisible();
  await expect(buddy.locator('[data-effect="berry"]')).toBeVisible();
  await expect(buddy.locator('[data-sprite-motion]')).toHaveAttribute('data-requested-action', 'Eat');
  await expect(buddy.locator('[data-sprite-motion]')).toHaveAttribute('data-action', 'Idle'); // No Eat sheet for this exact form.
  await expect(buddy.locator('[data-shared-effect="berry"]')).toHaveAttribute('data-ready', 'true');
  expect(await home.evaluate(() => state.active.xp)).toBeGreaterThan(before.xp);
  expect(await home.evaluate(() => state.active.active_seconds)).toBe(before.seconds);
  await capture(home, 'pocodex-berry.png');
  await home.getByRole('button', { name: /^Pet/ }).click();
  await expect(buddy.locator('[data-effect="pet"]')).toBeVisible();
  await expect(buddy.locator('[data-sprite-motion]')).toHaveAttribute('data-requested-action', 'Nod');
  await expect(buddy.locator('[data-shared-effect="heart"]').first()).toHaveAttribute('data-ready', 'true');
  await capture(buddy, 'pocodex-petting.png');
  for (let i = 1; i < 10; i++) {
    await home.getByRole('button', { name: /^Pet/ }).click();
    await expect.poll(() => home.evaluate(() => state.treats.pets_left)).toBe(9 - i);
  }
  await expect(home.getByRole('button', { name: /^Pet/ })).toBeDisabled();
  const saved = await home.evaluate(() => ({ xp: state.active.xp, berries: state.treats.berries }));
  await application.close();
  application = await launch();
  await expect.poll(() => application.windows().length).toBe(2);
  home = application.windows().find(w => w.url().includes('view=home'));
  await expect(home.getByRole('button', { name: /^Pet/ })).toBeDisabled();
  expect(await home.evaluate(() => ({ xp: state.active.xp, berries: state.treats.berries }))).toEqual(saved);
  await expect(home.locator('[data-effect]')).toHaveCount(0);
});

for (const reduced of [false, true]) test(`evolution transforms both views and plays the new cry once (reduced motion: ${reduced})`, async () => {
  await seedCollection();
  const buddy = application.windows().find(w => w.url().includes('view=buddy'));
  await home.evaluate(reduced_motion => window.pocodex.command('settings', { sound: true, reduced_motion }), reduced);
  await home.getByRole('button', { name: 'Pokédex', exact: true }).click();
  await home.getByRole('searchbox').fill('Squirtle');
  await home.getByRole('button', { name: /Squirtle, level/ }).click();
  await home.getByRole('button', { name: 'Take along', exact: true }).first().click();
  await home.getByRole('button', { name: 'Evolve', exact: true }).click();
  await home.getByRole('dialog').getByRole('button', { name: 'Evolve', exact: true }).click();
  await expect(home.locator('[data-effect="evolve"]')).toBeVisible();
  await expect(buddy.locator('[data-effect="evolve"]')).toBeVisible();
  if (!reduced) await expect(buddy.locator('.bubble')).toHaveText('What? Squirtle is evolving!');
  expect(await buddy.locator('[data-effect="evolve"]').evaluate(el => getComputedStyle(el).animationName)).toBe(reduced ? 'none' : 'evolution-presence');
  const motion = view => view.locator('canvas[data-sprite-motion]');
  if (reduced) {
    for (const view of [home, buddy]) {
      await expect(motion(view)).toHaveAttribute('data-sprite-sheet', '8-action-Idle.png');
      expect(await motion(view).getAttribute('data-evolution-form')).toBeNull();
    }
  } else {
    // The live canvas draws exactly one form per frame: old form, alternating silhouettes, new form.
    const samples = await Promise.all([home, buddy].map(view => view.evaluate(async () => {
        const canvas = document.querySelector('canvas[data-sprite-motion]'), forms = [];
        for (let i = 0; i < 90; i++) { forms.push(canvas.dataset.evolutionForm || canvas.dataset.action); await new Promise(r => setTimeout(r, 40)); }
        return forms;
      })));
    for (const seen of samples) {
      expect(seen.indexOf('before')).toBeGreaterThanOrEqual(0);
      expect(seen.lastIndexOf('after')).toBeGreaterThan(seen.indexOf('before'));
      expect(seen.at(-1)).not.toBe('before');
    }
    await expect(buddy.locator('.bubble')).toHaveText('Congratulations! Squirtle evolved into Wartortle!');
    await capture(buddy, 'pocodex-evolution-new-form.png');
  }
  await expect.poll(() => buddy.evaluate(() => audio?.src.includes(state.active.species.cry) && !audio.error)).toBe(true);
  await capture(home, `pocodex-evolution-${reduced ? 'still' : 'animated'}.png`);
  await application.close();
  application = await launch();
  await expect.poll(() => application.windows().length).toBe(2);
  const restarted = application.windows().find(w => w.url().includes('view=buddy'));
  await expect(restarted.locator('.buddy-caption')).toContainText('Wartortle');
  expect(await restarted.evaluate(() => audio === undefined)).toBe(true);
  await expect(restarted.locator('[data-effect]')).toHaveCount(0);
});

test('cries require named events and idle, scenery and restart stay silent', async () => {
  await seedCollection();
  let buddy = application.windows().find(w => w.url().includes('view=buddy'));
  await home.getByRole('button', { name: 'Settings', exact: true }).click();
  await home.getByLabel('Play Pokémon cries').check();
  await expect.poll(() => buddy.evaluate(() => state.settings.sound)).toBe(true);
  await buddy.evaluate(() => { playCry('idle'); playCry('working'); playCry('random'); });
  expect(await buddy.evaluate(() => audio === undefined)).toBe(true);
  await home.getByLabel('Sprite scenery').selectOption('random');
  await home.getByRole('button', { name: 'Shuffle scenery' }).click();
  await buddy.evaluate(() => window.pocodex.command('snapshot'));
  expect(await buddy.evaluate(() => audio === undefined)).toBe(true);
  await fs.appendFile(path.join(source, 'sessions/live.jsonl'), JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_complete', turn_id: 'cry-turn' } }) + '\n');
  await expect.poll(() => buddy.evaluate(() => Boolean(audio && audio.readyState >= 2 && !audio.error))).toBe(true);
  const firstCry = await buddy.evaluate(() => lastSound);
  await fs.appendFile(path.join(source, 'sessions/live.jsonl'), JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_complete', turn_id: 'cry-turn' } }) + '\n');
  await buddy.evaluate(() => window.pocodex.command('snapshot'));
  expect(await buddy.evaluate(() => lastSound)).toBe(firstCry);
  await application.close();
  application = await launch();
  await expect.poll(() => application.windows().length).toBe(2);
  home = application.windows().find(w => w.url().includes('view=home'));
  buddy = application.windows().find(w => w.url().includes('view=buddy'));
  await expect(buddy.locator('.buddy-caption')).toContainText('Ivysaur');
  expect(await buddy.evaluate(() => audio === undefined)).toBe(true);
});

test('dragging the buddy moves its notice and the spot survives a restart', async () => {
  await seedCollection();
  const buddy = application.windows().find(w => w.url().includes('view=buddy'));
  const bounds = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=buddy')).getBounds());
  const start = await bounds();
  await buddy.evaluate(() => { window.pocodex.moveBuddy({ x: -140, y: -70 }); window.pocodex.moveBuddy({ x: -20, y: -10 }); });
  await expect.poll(async () => (await bounds()).x).toBe(start.x - 160);
  const moved = await bounds();
  await expect.poll(async () => JSON.parse(await fs.readFile(path.join(profileOverride, 'window.json'), 'utf8').catch(() => '{}')).x).toBe(moved.x);
  await application.close();
  application = await launch();
  await expect.poll(() => application.windows().length).toBe(2);
  expect(await bounds()).toEqual(moved);
});

// ---- 0.2: Codex and Claude Code together -------------------------------------------------------
const claudeHome = () => path.join(temporary, 'claude-home');
const claudeSettings = async () => JSON.parse(await fs.readFile(path.join(claudeHome(), 'settings.json'), 'utf8'));
function claudeHook(profile, payload) {
  execFileSync(path.join(__dirname, '../../.venv/Scripts/python.exe'), ['-m', 'observatory.companion.hook', 'claude-event', '--profile', profile, '--pocodex'],
    { input: JSON.stringify(payload), cwd: path.join(__dirname, '../..') });
}
async function relaunchWithClaude(settings = { theme: 'dark' }) {
  await fs.mkdir(claudeHome(), { recursive: true });
  if (settings !== null) await fs.writeFile(path.join(claudeHome(), 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings));
  await application.close();
  application = await launch();
  await expect.poll(() => application.windows().length).toBe(2);
  home = application.windows().find(w => w.url().includes('view=home'));
}

test('first run connects both apps into isolated folders, and an untick survives live updates', async () => {
  await relaunchWithClaude();
  await home.getByRole('button', { name: 'Skip intro' }).click();
  await expect(home.getByLabel('Claude Code', { exact: true })).toBeChecked();
  await home.getByLabel('Claude Code', { exact: true }).uncheck();
  // A state refresh arrives at least every five seconds; the user's choice must survive it.
  const before = await home.evaluate(() => state.now);
  await expect.poll(() => home.evaluate(() => state.now), { timeout: 8000 }).toBeGreaterThan(before + 4);
  await expect(home.getByLabel('Claude Code', { exact: true })).not.toBeChecked();
  await finishIntro();
  await expect(home.getByText('Two active minutes to hatch')).toBeVisible();
  expect(await claudeSettings()).toEqual({ theme: 'dark' });
  await expect(home.locator('.hp-box[data-app="claude"]')).toHaveAttribute('data-state', 'off');
  await home.locator('.hp-box[data-app="claude"]').getByRole('button', { name: 'Connect' }).click();
  await expect(home.locator('.hp-box[data-app="claude"]')).toHaveAttribute('data-state', 'missing');
  const connected = await claudeSettings();
  expect(connected.theme).toBe('dark');
  expect(Object.keys(connected.hooks).sort()).toEqual(['Notification', 'PostToolUse', 'PreToolUse', 'SessionEnd', 'Stop', 'StopFailure', 'UserPromptSubmit']);
  expect(connected.statusLine.command).toContain('--pocodex');
  await home.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(home.getByText(/Connected · waiting for the first reply/).first()).toBeVisible();
  await home.getByLabel('Watch Claude Code').uncheck();
  await expect.poll(claudeSettings).toEqual({ theme: 'dark' });
  await expect(home.getByLabel('Watch Claude Code')).not.toBeChecked();
});

test('unreadable Claude settings are left untouched and explained with a paste-in snippet', async () => {
  const broken = '{ "theme": "dark", // a comment makes this not JSON\n}';
  await relaunchWithClaude(broken);
  await home.getByRole('button', { name: 'Skip intro' }).click();
  await home.locator('[data-intro="connect"]').click();
  await expect(home.locator('#error')).toContainText('Settings > Connections');
  // The intro stays put with Claude Code unticked, so Next carries on without it.
  await expect(home.getByLabel('Claude Code', { exact: true })).not.toBeChecked();
  await home.getByRole('button', { name: 'Dismiss message' }).click();
  await expect(home.locator('#error')).toBeHidden();
  await finishIntro();
  expect(await fs.readFile(path.join(claudeHome(), 'settings.json'), 'utf8')).toBe(broken);
  await home.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(home.locator('.settings-problem')).toContainText('left the file unchanged');
  await expect(home.locator('.snippet')).toContainText('--pocodex');
  await expect(home.getByLabel('Watch Claude Code')).not.toBeChecked();
});

test('both apps grow one buddy, share one queue and clear a permission once Claude resumes', async () => {
  await fs.mkdir(claudeHome(), { recursive: true });
  await seedCollection();
  const buddy = application.windows().find(w => w.url().includes('view=buddy'));
  await home.getByRole('button', { name: 'Settings', exact: true }).click();
  await home.getByLabel('Watch Claude Code').check();
  await expect(home.getByText(/Connected · waiting for the first reply/).first()).toBeVisible();
  const transcript = path.join(temporary, 'claude-transcript.jsonl');
  await fs.writeFile(transcript, '');
  const append = (type, payload) => fs.appendFile(path.join(source, 'sessions/live.jsonl'), JSON.stringify({ type, payload, timestamp: new Date().toISOString() }) + '\n');
  claudeHook(profileOverride, { hook_event_name: 'UserPromptSubmit', session_id: 'c1', cwd: 'C:/fixture/pokedex-api', transcript_path: transcript, prompt: 'PRIVATE PROMPT' });
  await expect(buddy.locator('.bubble')).toHaveText('Claude is working');
  await append('event_msg', { type: 'task_started', turn_id: 'both' });
  await expect(buddy.locator('.bubble')).toHaveText('Codex and Claude are working');
  await expect(buddy.locator('.buddy-caption')).toContainText('2 working');
  // Wait for Claude time beyond a baseline, so the XP comparison cannot race the first credit.
  const start = await home.evaluate(() => ({ xp: state.active.xp, claude: state.active.active_by_app.claude || 0 }));
  await expect.poll(() => home.evaluate(() => state.active.active_by_app.claude || 0), { timeout: 10000 }).toBeGreaterThan(start.claude + 1);
  expect(await home.evaluate(() => state.active.xp)).toBeGreaterThan(start.xp);
  claudeHook(profileOverride, { hook_event_name: 'Notification', session_id: 'c1', notification_type: 'permission_prompt', message: 'PRIVATE COMMAND' });
  await append('response_item', { type: 'function_call', name: 'request_user_input', call_id: 'both-q', arguments: '{}' });
  await expect(buddy.locator('.bubble')).toHaveText('Your move, Trainer! Codex and Claude need you');
  await home.getByRole('button', { name: 'Buddy', exact: true }).click();
  await expect(home.locator('.attention-card .app-tag[data-app="claude"]')).toBeVisible();
  await expect(home.getByText('Allow or deny it in Claude Code.')).toBeVisible();
  await expect(home.locator('body')).not.toContainText('PRIVATE');
  await fs.appendFile(transcript, '{"type":"user"}\n');  // the approved command ran
  await expect(home.getByText('Allow or deny it in Claude Code.')).toHaveCount(0);
  await append('response_item', { type: 'function_call_output', call_id: 'both-q', output: '{}' });
  await expect(buddy.locator('.bubble')).toHaveText('Codex and Claude are working');
  await capture(home, 'pocodex-two-apps.png');
});

test('allowance boxes show observed windows, age stale ones and warn the buddy when low', async () => {
  await fs.mkdir(claudeHome(), { recursive: true });
  await seedCollection();
  const buddy = application.windows().find(w => w.url().includes('view=buddy'));
  await home.getByRole('button', { name: 'Settings', exact: true }).click();
  await home.getByLabel('Watch Claude Code').check();
  await home.getByRole('button', { name: 'Buddy', exact: true }).click();
  const now = Date.now() / 1000;
  await fs.writeFile(path.join(profileOverride, 'claude-limits.json'), JSON.stringify({ at: now, rate_limits: { five_hour: { used_percentage: 88, resets_at: now + 3600 }, seven_day: { used_percentage: 40, resets_at: now + 86400 * 3 } } }));
  await fs.appendFile(path.join(source, 'sessions/live.jsonl'), JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'token_count', rate_limits: { primary: { used_percent: 23, window_minutes: 300, resets_at: now + 2000 } } } }) + '\n');
  const claudeBox = home.locator('.hp-box[data-app="claude"]'), codexBox = home.locator('.hp-box[data-app="codex"]');
  await expect(claudeBox).toHaveAttribute('data-tone', 'low');
  await expect(claudeBox.getByRole('progressbar', { name: /Claude: 12% of the 5 h allowance left/ })).toBeVisible();
  await expect(claudeBox.getByRole('progressbar', { name: /60% of the weekly allowance left/ })).toBeVisible();
  await expect(codexBox).toHaveAttribute('data-tone', 'high');
  await expect(buddy.locator('.buddy-caption small')).toHaveText('Claude 5 h: 12% left');
  await capture(home, 'pocodex-allowance.png');
  await fs.writeFile(path.join(profileOverride, 'claude-limits.json'), JSON.stringify({ at: now - 3 * 3600, rate_limits: { five_hour: { used_percentage: 50, resets_at: now - 60 } } }));
  await expect(claudeBox).toHaveAttribute('data-state', 'stale');
  await expect(claudeBox).toContainText('Last seen 3 h ago');
  await expect(buddy.locator('.buddy-caption small')).not.toHaveText(/left/);
  await fs.writeFile(path.join(profileOverride, 'claude-limits.json'), '{not json');
  await new Promise(resolve => setTimeout(resolve, 1500));
  await expect(claudeBox).toHaveAttribute('data-state', 'stale');  // a corrupt file never blanks the last good reading
});

test('a usage limit hit in any Claude session empties its box until the reset', async () => {
  await fs.mkdir(claudeHome(), { recursive: true });
  await seedCollection();
  const buddy = application.windows().find(w => w.url().includes('view=buddy'));
  await home.getByRole('button', { name: 'Settings', exact: true }).click();
  await home.getByLabel('Watch Claude Code').check();
  await home.getByRole('button', { name: 'Buddy', exact: true }).click();
  const claudeBox = home.locator('.hp-box[data-app="claude"]');
  await expect(claudeBox).toHaveAttribute('data-state', 'missing');
  await expect(claudeBox).toContainText('Terminal sessions share this live');
  // The desktop app has no status line; the refusal Claude Code logs is the one exact reading it leaves.
  const transcript = path.join(temporary, 'limited.jsonl'), reset = Math.floor(Date.now() / 1000) + 5400;
  await fs.writeFile(transcript, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), isApiErrorMessage: true, error: 'rate_limit',
    quotaLimits: { status: 'rejected', resetsAt: reset, rateLimitType: 'five_hour' },
    message: { id: 'refused', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'Limit reached' }] } }) + '\n');
  const hook = event => claudeHook(profileOverride, { hook_event_name: event, session_id: 'limited', transcript_path: transcript, cwd: 'C:/demo/limited' });
  hook('UserPromptSubmit');
  hook('StopFailure');
  await expect(claudeBox).toHaveAttribute('data-tone', 'out');
  await expect(claudeBox.getByRole('progressbar', { name: 'Claude: 0% of the 5 h allowance left' })).toBeVisible();
  await expect(claudeBox).toContainText('Resets');
  await expect(buddy.locator('.bubble')).toHaveText('Out of PP! Claude allowance used up');
});

test("the opt-in usage check reads Claude Code's /usage screen and removes its session", async () => {
  await fs.mkdir(claudeHome(), { recursive: true });
  await seedCollection();
  await home.getByRole('button', { name: 'Settings', exact: true }).click();
  const check = home.getByLabel("Check Claude's usage with Claude Code");
  await expect(check).toBeDisabled();  // needs Claude Code connected first
  await home.getByLabel('Watch Claude Code').check();
  await expect(check).not.toBeChecked();
  await check.check();
  await expect(home.locator('#usage-check-status')).toHaveText(/Checked 1 min ago/);
  await home.getByRole('button', { name: 'Buddy', exact: true }).click();
  const claudeBox = home.locator('.hp-box[data-app="claude"]');
  await expect(claudeBox.getByRole('progressbar', { name: 'Claude: 58% of the 5 h allowance left' })).toBeVisible();
  await expect(claudeBox.getByRole('progressbar', { name: 'Claude: 43% of the weekly allowance left' })).toBeVisible();
  // The fake CLI logged every call: the guards were on and the session was removed.
  const calls = (await fs.readFile(path.join(profileOverride, 'claude-usage-check', 'calls.jsonl'), 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
  const folder = path.join(profileOverride, 'claude-usage-check');
  expect(calls[0]).toEqual(['--bg', '--model', 'pocodex-usage-check-no-model', '--settings', path.join(folder, 'check-settings.json'), '/usage']);
  expect(JSON.parse(await fs.readFile(path.join(folder, 'check-settings.json'), 'utf8'))).toEqual({ disableAllHooks: true });
  expect(calls.slice(-2)).toEqual([['stop', 'f00dcafe'], ['rm', 'f00dcafe']]);
});

// ---- Wild battles and the Trainer Card ------------------------------------------------------------
const waitForMenu = page => page.waitForSelector('[data-battle="fight"], [data-battle="close"]', { timeout: 60000 });

test('a wild battle plays out from Home, pays out and hands the window back', async () => {
  await seedCollection();
  const buddy = application.windows().find(w => w.url().includes('view=buddy'));
  const before = await home.evaluate(() => ({ left: state.battles_left, won: state.stats.battles_won, lost: state.stats.battles_lost }));
  await home.getByRole('button', { name: 'Look for wild Pokémon' }).click();
  await expect(home.locator('.battle-text')).toContainText(/A wild .+ appeared!/);
  const wild = await home.evaluate(() => state.battle.wild.name);
  await expect(buddy.locator('.bubble')).toHaveText(`Battling a wild ${wild}!`);
  await waitForMenu(home);
  // The battle is modal: Home underneath is inert, so Tab stays inside the battle.
  expect(await home.evaluate(() => document.querySelector('#app').inert)).toBe(true);
  for (let i = 0; i < 6; i++) await home.keyboard.press('Tab');
  expect(await home.evaluate(() => Boolean(document.activeElement.closest('#battle')) || document.activeElement === document.body)).toBe(true);
  await home.keyboard.press('Escape');  // Escape never abandons Home mid-battle.
  expect(application.windows().some(w => w.url().includes('view=home'))).toBe(true);
  await home.getByRole('button', { name: 'Fight' }).click();
  const moves = await home.locator('[data-battle="move"]').count();
  expect(moves).toBeGreaterThan(0);
  await home.locator('[data-battle="move"]').first().click();
  await expect(home.locator('.battle-text')).toContainText(/used .+!/);
  await waitForMenu(home);
  while (await home.locator('[data-battle="auto"]').count()) {
    await home.getByRole('button', { name: 'Auto' }).click();
    await waitForMenu(home);
  }
  const after = await home.evaluate(() => ({ over: state.battle.over, left: state.battles_left, won: state.stats.battles_won, lost: state.stats.battles_lost }));
  expect(['won', 'lost']).toContain(after.over);
  expect(after.left).toBe(before.left - 1);
  expect(after.won + after.lost).toBe(before.won + before.lost + 1);
  await capture(home, 'pocodex-battle-end.png');
  await home.getByRole('button', { name: 'Continue' }).click();
  await expect(home.locator('#battle')).toBeHidden();
  await expect(home.getByText(`${before.left - 1} of 5 battles left today`, { exact: false })).toBeVisible();
});

test('a form without an action sheet still battles, drawn from its Pokédex sprite', async () => {
  await seedCollection(10099);  // Pikachu in a cap has no PMD action sheet.
  const errors = [];
  home.on('pageerror', error => errors.push(error.message));
  expect(await home.evaluate(() => state.active.species.id)).toBe(10099);
  await home.getByRole('button', { name: 'Look for wild Pokémon' }).click();
  await waitForMenu(home);
  await home.getByRole('button', { name: 'Fight' }).click();
  await home.locator('[data-battle="move"]').first().click();
  await expect(home.locator('.battle-text')).toContainText(/used .+!/);
  await waitForMenu(home);
  await capture(home, 'pocodex-battle-still-sprite.png');
  expect(errors).toEqual([]);
});

test('a double-click sends one turn, a ball is spent, and a battle resumes after restart', async () => {
  await seedCollection();
  await home.getByRole('button', { name: 'Look for wild Pokémon' }).click();
  await waitForMenu(home);
  await home.getByRole('button', { name: 'Fight' }).click();
  await home.locator('[data-battle="move"]').first().dblclick();
  await waitForMenu(home);
  expect(await home.evaluate(() => state.battle.turn)).toBe(1);
  if (await home.locator('[data-battle="bag"]').count()) {
    const balls = await home.evaluate(() => state.balls);
    await home.getByRole('button', { name: 'Bag', exact: true }).click();
    await home.locator('[data-battle="ball"]').click();
    await expect(home.locator('.battle-text')).toContainText('You threw a Poké Ball!');
    await waitForMenu(home);
    const now = await home.evaluate(() => ({ balls: state.balls, over: state.battle.over }));
    expect(now.balls).toBe(now.over === 'caught' ? balls : balls - 1);
  }
  const battle = await home.evaluate(() => ({ id: state.battle.id, turn: state.battle.turn, over: state.battle.over }));
  await application.close();
  application = await launch();
  await expect.poll(() => application.windows().length).toBe(2);
  home = application.windows().find(w => w.url().includes('view=home'));
  await expect(home.locator('#battle')).toBeVisible();
  await waitForMenu(home);
  expect(await home.evaluate(() => ({ id: state.battle.id, turn: state.battle.turn, over: state.battle.over }))).toEqual(battle);
  // A resumed battle skips its entrance.
  await expect(home.locator('.battle-text')).not.toContainText('appeared');
});

test('the Trainer Card shows real records, copies the exact card and keeps a valid name', async () => {
  await seedCollection();
  await home.getByRole('button', { name: 'Pokédex', exact: true }).click();
  await home.getByRole('button', { name: /Trainer Card/ }).click();
  const card = home.locator('[data-card]');
  await expect(card).toContainText('5 owned');
  await expect(card.locator('.badge-slot .emblem.earned')).toHaveCount(await home.evaluate(() => state.badges.filter(b => b.earned).length));
  await expect(card).toHaveClass(/tier-(blue|green)/);
  await home.getByRole('button', { name: 'Copy image' }).click();
  await expect(home.locator('.card-note')).toHaveText('Copied. Paste it anywhere.');
  const copied = await application.evaluate(async ({ clipboard }) => {
    const items = await clipboard.read();
    const item = items.find(i => i.types.includes('image/png'));
    return item ? (await (await item.getType('image/png')).arrayBuffer()).byteLength : 0;
  });
  expect(copied).toBeGreaterThan(5000);
  await home.getByRole('button', { name: 'Show back' }).click();
  await expect(card).toHaveClass(/flipped/);
  await expect(card).toContainText('First partner');
  await home.locator('#trainer-name').fill('Red');
  await home.getByRole('button', { name: 'Save name' }).click();
  await expect(card.locator('.card-row.name dd')).toHaveText('Red');
  await home.locator('#trainer-name').fill('   ');
  await home.getByRole('button', { name: 'Save name' }).click();
  await expect(home.locator('#error')).toContainText('Trainer names are 1 to 12 characters');
  expect(await home.evaluate(() => state.trainer.name)).toBe('Red');
  await capture(home, 'pocodex-trainer-card.png');
  // A refresh that rebuilds the card must not snap a half-typed name back to the saved one.
  await home.locator('#trainer-name').fill('Blu');
  await home.evaluate(() => { document.querySelector('#trainer-name').setSelectionRange(1, 2); lastMarkup = ''; render(); });
  expect(await home.evaluate(() => { const input = document.activeElement; return [input.id, input.value, input.selectionStart, input.selectionEnd]; })).toEqual(['trainer-name', 'Blu', 1, 2]);
});
