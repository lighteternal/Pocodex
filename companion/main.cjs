const { app, BrowserWindow, ipcMain, protocol, net, session, screen, Tray, Menu, nativeImage, dialog, clipboard, ClipboardItem } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { Bridge, clampBounds, validCommand } = require('./bridge.cjs');
const { startupController } = require('./startup.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'pocodex', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
app.setName('Pocodex');
// This small 2D companion does not need a hardware-backed compositor.
app.disableHardwareAcceleration();
const profileArg = process.argv.find(a => a.startsWith('--profile='));
const preview = process.argv.includes('--preview');
if (profileArg) app.setPath('userData', path.resolve(profileArg.slice(10)));
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
let buddy, home, homeReady, homeBounds, updates, updatesReady, updatesTimer, bridge, tray, pendingClosePreference, quitting = false, latest = null, lastFault = null, lastTooltip = 'Pocodex';
const announced = new Set();
const BUDDY_HEIGHT = 240;
const updateKinds = new Set(['completed', 'input_needed', 'stopped', 'limit_reached', 'low_allowance']);
let updateId = null;
function updateState(state) {
  return { settings: state.settings, telemetry: { activity: state.telemetry.activity,
    attention: state.telemetry.attention.filter(e => e.id === updateId) } };
}
const assets = app.isPackaged ? path.join(process.resourcesPath, 'assets') : path.join(__dirname, 'assets');
const profile = app.getPath('userData');
const positionFile = path.join(profile, 'window.json');
const startup = startupController(app, profile, process.argv.filter(a => a.startsWith('--source=') || a === '--preview'));

function safeSender(event) {
  if (![buddy?.webContents, home?.webContents, updates?.webContents].includes(event.sender) || !event.senderFrame?.url.startsWith('pocodex://app/')) throw new Error('Untrusted Pocodex message origin');
}
function hideUpdates() {
  clearTimeout(updatesTimer);
  if (updates && !updates.isDestroyed()) updates.destroy();
}
function updateBounds() {
  const anchor = buddy.getBounds(), area = screen.getDisplayMatching(anchor).workArea;
  // The top of the transparent buddy window is empty; the notice sits just above the speech bubble.
  const y = anchor.y - 170 + 36;
  return clampBounds({ x: anchor.x + anchor.width / 2 - 160, y: y >= area.y ? y : anchor.y + anchor.height + 8, width: 320, height: 170 }, area);
}
async function finishUpdates() {
  const ident = updateId;
  try { await bridge.request('acknowledge', { id: ident }); }
  catch { hideUpdates(); console.warn(JSON.stringify({ event: 'update_clear_failed' })); }
}
function showUpdates(manual = false) {
  if (quitting || !latest?.telemetry.attention.some(e => updateKinds.has(e.kind))) return;
  if (!manual && (!latest.settings.auto_updates || latest.settings.quiet || !buddy?.isVisible())) return;
  const eligible = latest.telemetry.attention.filter(e => updateKinds.has(e.kind));
  const current = eligible.find(e => e.id === updateId);
  const next = eligible.find(e => e.kind === 'input_needed') || eligible.find(e => e.kind === 'limit_reached') || current || eligible[0];
  if (updates && current && next.id === updateId && !manual) return;
  updateId = next.id;
  clearTimeout(updatesTimer);
  if (!updates) {
    const bounds = updateBounds();
    const window = secureWindow({ ...bounds, title: 'Pocodex updates', frame: false, backgroundColor: '#f8f8ec', resizable: false, skipTaskbar: true, show: false });
    updates = window;
    window.setAlwaysOnTop(true, 'pop-up-menu');
    window.on('closed', () => { if (updates === window) { updates = null; updatesReady = null; } });
    updatesReady = window.loadURL(`pocodex://app/index.html?view=updates${preview ? '&preview=1' : ''}`);
  }
  const window = updates;
  updatesReady.then(() => { if (!window.isDestroyed() && !quitting) { window.webContents.send('state', { state: updateState(latest) }); window.showInactive(); if (manual) window.focus(); } })
    .catch(failure => console.error(JSON.stringify({ event: 'updates_window_load_failed', code: failure.code || 'unknown' })));
  if (next.kind !== 'input_needed') updatesTimer = setTimeout(finishUpdates, 20000);
}
// Dragging uses setBounds, which never emits 'moved' on Windows: persist and re-anchor from here.
let positionTimer = null;
function savePosition() {
  clearTimeout(positionTimer); positionTimer = null;
  try { fs.writeFileSync(positionFile, JSON.stringify(buddy.getBounds())); } catch { console.warn(JSON.stringify({ event: 'window_position_unsaved' })); }
}
function buddyMoved() {
  if (updates && !updates.isDestroyed()) updates.setBounds(updateBounds());
  clearTimeout(positionTimer);
  positionTimer = setTimeout(savePosition, 400);
}
function showHome(requestedPage) {
  const page = ['home', 'dex', 'usage', 'settings', 'card'].includes(requestedPage) ? requestedPage : null;
  if (quitting || !app.isReady()) return;
  if (!home) {
    const window = secureWindow({ width: 496, height: 800, ...homeBounds, minWidth: 360, minHeight: 520, title: 'Pocodex', backgroundColor: '#171e20', show: false, autoHideMenuBar: true,
      titleBarStyle: 'hidden', titleBarOverlay: { color: '#c4372e', symbolColor: '#fff5ec', height: 44 } });
    home = window;
    window.setMenu(null);
    const iconPath = path.join(assets, 'icon.png');
    if (fs.existsSync(iconPath)) window.setIcon(nativeImage.createFromPath(iconPath));
    window.on('close', event => {
      homeBounds = window.getBounds();
      if (!quitting && pendingClosePreference) {
        event.preventDefault();
        pendingClosePreference.then(() => { if (!window.isDestroyed()) window.close(); }, () => showHome());
        return;
      }
      if (!quitting && latest?.settings.close_exits) { event.preventDefault(); app.quit(); }
    });
    window.on('closed', () => { if (home === window) { home = null; homeReady = null; } });
    homeReady = window.loadURL(`pocodex://app/index.html?view=home${preview ? '&preview=1' : ''}`);
  }
  const window = home;
  homeReady.then(() => {
    if (window.isDestroyed() || quitting) return;
    // Reopen on the monitor it was left on; only a window left on a disconnected monitor follows the cursor.
    const bounds = window.getBounds(), overlaps = area => bounds.x < area.x + area.width && area.x < bounds.x + bounds.width && bounds.y < area.y + area.height && area.y < bounds.y + bounds.height;
    const display = screen.getAllDisplays().some(d => overlaps(d.workArea)) ? screen.getDisplayMatching(bounds) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    window.setBounds(clampBounds(bounds, display.workArea));
    if (page) window.webContents.send('navigate', page);
    window.show(); window.focus();
    if (lastFault) window.webContents.send('fault', lastFault);
  }).catch(failure => console.error(JSON.stringify({ event: 'home_window_load_failed', code: failure.code || 'unknown' })));
}
function hideHome() {
  const window = home;
  setImmediate(() => {
    if (window && !window.isDestroyed()) { homeBounds = window.getBounds(); window.destroy(); }
  });
}
function sendAll(channel, payload) {
  for (const window of [buddy, home, updates]) if (window && !window.isDestroyed()) window.webContents.send(channel, window === updates && channel === 'state' ? { ...payload, state: updateState(payload.state), events: [] } : payload);
}
function secureWindow(options) {
  const window = new BrowserWindow({ ...options, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: !options.transparent } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  return window;
}
// Only observed, current five-hour windows; no guesses in the tray.
function allowanceTooltip(state) {
  const parts = [['codex', 'Codex'], ['claude', 'Claude']].flatMap(([key, name]) => {
    const five = state.telemetry.apps?.[key]?.quota?.find(q => q.label === '5h' && !q.stale);
    return five ? [`${name} ${five.remaining}%`] : [];
  });
  return parts.length ? `Pocodex · ${parts.join(' · ')} left` : 'Pocodex';
}
function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Pocodex', click: showHome },
    { label: 'Codex updates', click: () => showUpdates(true) },
    { label: 'Pokédex', click: () => showHome('dex') },
    { label: 'Trainer Card', click: () => showHome('card') },
    { label: 'Properties / Settings', click: () => showHome('settings') },
    { label: 'Close window', click: hideHome },
    { type: 'separator' },
    { label: buddy?.isVisible() ? 'Hide buddy' : 'Show buddy', click: () => { if (buddy.isVisible()) buddy.hide(); else buddy.showInactive(); refreshTray(); } },
    { label: latest?.settings.sound ? 'Mute sound' : 'Enable sound', click: () => bridge.request('settings', { sound: !latest?.settings.sound }).catch(() => {}) },
    { type: 'separator' }, { label: 'Quit completely', click: () => app.quit() },
  ]));
}

app.whenReady().then(async () => {
  if (!ownsInstance) return;
  Menu.setApplicationMenu(null);
  fs.mkdirSync(profile, { recursive: true });
  protocol.handle('pocodex', request => {
    const url = new URL(request.url);
    const filename = decodeURIComponent(url.pathname.slice(1));
    let target;
    if (url.hostname === 'app' && filename === 'markdown-it.js') target = require.resolve('markdown-it/browser');
    if (url.hostname === 'app' && ['index.html', 'app.js', 'action-state.js', 'sprite-layout.js', 'sprite-motion.js', 'lore.js', 'allowance.js', 'battle.js', 'trainer-card.js', 'intro.js', 'scenery.js', 'style.css', 'egg.svg'].includes(filename)) target = path.join(__dirname, 'ui', filename);
    if (url.hostname === 'app' && filename === 'fonts/pokemon-classic.ttf') target = path.join(__dirname, 'ui', filename);
    if (url.hostname === 'app' && /^icons\/(speaker-high|speaker-slash|x|check|arrow-up-right|magnifying-glass|paw-print|book-open|chart-bar|gear-six|heart-pixel|berry-pixel)\.svg$/.test(filename)) target = path.join(__dirname, 'ui', filename);
    if (url.hostname === 'assets' && /^\d+-(sprite|cry)\.(gif|png|ogg|mp3)$/.test(filename)) target = path.join(assets, filename);
    if (url.hostname === 'app' && /^assets\/\d+-sprite\.(gif|png)$/.test(filename)) target = path.join(assets, filename.slice(7));
    if (url.hostname === 'app' && /^assets\/(actions\.json|\d+-action-[A-Za-z]+\.png|effect-[a-z]+\.png|intro-oak\.png)$/.test(filename)) target = path.join(assets, filename.slice(7));
    return target ? net.fetch(pathToFileURL(target).href) : new Response('Not found', { status: 404 });
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
  const area = screen.getPrimaryDisplay().workArea;
  let bounds = { x: area.x + area.width - 230, y: area.y + area.height - 260, width: 200, height: BUDDY_HEIGHT };
  try {
    const stored = JSON.parse(fs.readFileSync(positionFile, 'utf8'));
    // Saves from the shorter window keep the Pokemon's feet where the user left them.
    if (Number.isFinite(stored.x) && Number.isFinite(stored.y)) bounds = { ...bounds, x: stored.x, y: stored.y - (Number.isFinite(stored.height) ? BUDDY_HEIGHT - stored.height : 0) };
  } catch (error) { if (error.code !== 'ENOENT') console.warn('window_position_unavailable'); }
  bounds = clampBounds(bounds, screen.getDisplayMatching(bounds).workArea);
  buddy = secureWindow({ ...bounds, title: 'Pocodex buddy', frame: false, transparent: true, backgroundColor: '#00000000', resizable: false, skipTaskbar: true, focusable: false, show: false, hasShadow: false });
  buddy.setIgnoreMouseEvents(true, { forward: true });
  buddy.on('hide', hideUpdates);
  buddy.webContents.on('context-menu', () => Menu.buildFromTemplate([
    { label: 'Open Pocodex', click: showHome },
    { label: 'Properties / Settings', click: () => showHome('settings') },
    { label: 'Hide buddy', click: () => { buddy.hide(); refreshTray(); } },
    { type: 'separator' }, { label: 'Quit completely', click: () => app.quit() },
  ]).popup({ window: buddy }));
  buddy.on('moved', buddyMoved);
  screen.on('display-removed', () => {
    const current = buddy.getBounds(); buddy.setBounds(clampBounds(current, screen.getDisplayMatching(current).workArea)); buddyMoved();
  });
  await buddy.loadURL(`pocodex://app/index.html?view=buddy${preview ? '&preview=1' : ''}`);
  buddy.showInactive();
  const iconPath = path.join(assets, 'icon.png');
  if (fs.existsSync(iconPath)) {
    const icon = nativeImage.createFromPath(iconPath); tray = new Tray(icon.resize({ width: 20, height: 20 })); tray.setToolTip('Pocodex'); tray.on('click', showHome); refreshTray();
  }
  const sourceArgs = process.argv.filter(a => a.startsWith('--source=')).flatMap(a => ['--source', a.slice(9)]);
  const claudeArgs = [...process.argv.filter(a => a.startsWith('--claude-config=')).flatMap(a => ['--claude-config', a.slice(16)]),
    ...process.argv.filter(a => a.startsWith('--claude-cli=')).flatMap(a => ['--claude-cli', a.slice(13)])];
  // Claude Code launches this directly (exec form, no shell) for each hook it fires.
  const hookCommand = app.isPackaged
    ? [path.join(process.resourcesPath, 'runtime', 'pocodex-hook', 'pocodex-hook.exe')]
    : [path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe'), '-m', 'observatory.companion.hook'];
  const backendArgs = ['--data', profile, '--assets', assets, ...sourceArgs, ...claudeArgs, '--hook-command', JSON.stringify(hookCommand)];
  const command = app.isPackaged ? path.join(process.resourcesPath, 'runtime', 'pocodex-core.exe') : path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe');
  const args = app.isPackaged ? backendArgs : ['-m', 'observatory.companion.service', ...backendArgs];
  bridge = new Bridge(command, args, { cwd: app.isPackaged ? process.resourcesPath : path.join(__dirname, '..') });
  bridge.on('state', message => {
    const previous = latest;
    const first = !previous; latest = message.state;
    // Electron's default Windows level can demote the buddy behind other apps.
    if (first || previous.settings.always_on_top !== latest.settings.always_on_top) buddy.setAlwaysOnTop(Boolean(latest.settings.always_on_top), 'pop-up-menu');
    sendAll('state', message);
    if (updates && !latest.telemetry.attention.some(e => e.id === updateId)) {
      hideUpdates();
      showUpdates();
    }
    if (!latest.telemetry.attention.some(e => updateKinds.has(e.kind)) || latest.settings.quiet || !latest.settings.auto_updates) hideUpdates();
    const fresh = (message.events || []).filter(e => !announced.has(e.id));
    for (const event of fresh) announced.add(event.id);
    while (announced.size > 256) announced.delete(announced.values().next().value);
    if (fresh.some(e => updateKinds.has(e.kind) && latest.telemetry.attention.some(a => a.id === e.id))) showUpdates();
    if (first && (!latest.settings.onboarding || process.argv.includes('--show-home'))) showHome();
    if (first || previous.settings.sound !== latest.settings.sound) refreshTray();
    const tooltip = allowanceTooltip(latest);
    if (tray && tooltip !== lastTooltip) { tray.setToolTip(tooltip); lastTooltip = tooltip; }
  });
  bridge.on('fault', message => { lastFault = message; sendAll('fault', message); if (!quitting) showHome(); });
  startup.configure().then(result => { if (result.enabled && !quitting) startup.resume(); })
    .catch(() => console.warn(JSON.stringify({ event: 'startup_status_unavailable' })));
});

ipcMain.handle('snapshot', event => { safeSender(event); return latest && event.sender === updates?.webContents ? updateState(latest) : latest; });
ipcMain.handle('command', (event, action, args) => {
  safeSender(event);
  if (!validCommand(action, args)) throw new Error('Unsupported Pocodex action');
  const result = bridge.request(action, args);
  if (action === 'settings' && Object.hasOwn(args, 'close_exits')) {
    pendingClosePreference = result;
    const clear = () => { if (pendingClosePreference === result) pendingClosePreference = null; };
    result.then(clear, clear);
  }
  return result;
});
ipcMain.handle('show-home', event => { safeSender(event); showHome(); });
ipcMain.handle('hide-home', event => { safeSender(event); hideHome(); });
ipcMain.handle('show-updates', event => { safeSender(event); showUpdates(true); });
ipcMain.handle('hide-updates', event => { safeSender(event); return finishUpdates(); });
ipcMain.handle('quit-app', event => { safeSender(event); app.quit(); });
ipcMain.handle('startup', async (event, enabled) => {
  safeSender(event);
  if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('Startup choice must be on or off');
  const result = await startup.configure(enabled);
  if (enabled === true && !quitting) startup.resume();
  return result;
});
ipcMain.on('hit-region', (event, hit) => { safeSender(event); if (event.sender === buddy.webContents) buddy.setIgnoreMouseEvents(!Boolean(hit), { forward: true }); });
ipcMain.on('move-buddy', (event, delta) => {
  safeSender(event);
  if (event.sender !== buddy.webContents || !Number.isFinite(delta?.x) || !Number.isFinite(delta?.y)) return;
  const bounds = buddy.getBounds();
  const desired = { ...bounds, x: bounds.x + Math.max(-500, Math.min(500, delta.x)), y: bounds.y + Math.max(-500, Math.min(500, delta.y)) };
  buddy.setBounds(clampBounds(desired, screen.getDisplayNearestPoint({ x: desired.x, y: desired.y }).workArea));
  buddyMoved();
});
ipcMain.handle('add-source', async event => {
  safeSender(event);
  const result = await dialog.showOpenDialog(home, { title: 'Choose a Codex home containing sessions', properties: ['openDirectory'] });
  if (!result.canceled) return bridge.request('add_source', { path: result.filePaths[0] });
});
// The Trainer Card image is the card exactly as rendered, captured from Home.
ipcMain.handle('card-image', async (event, rect, kind) => {
  safeSender(event);
  if (event.sender !== home?.webContents || !['copy', 'save'].includes(kind) || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect?.[key]))) throw new Error('Unsupported card image request');
  const area = { x: Math.max(0, Math.round(rect.x)), y: Math.max(0, Math.round(rect.y)), width: Math.min(2000, Math.round(rect.width)), height: Math.min(2000, Math.round(rect.height)) };
  const image = await home.webContents.capturePage(area);
  // Electron 44 clipboard is the W3C-style async API: one PNG item.
  if (kind === 'copy') { await clipboard.write([new ClipboardItem({ 'image/png': new Blob([image.toPNG()], { type: 'image/png' }) })]); return true; }
  const result = await dialog.showSaveDialog(home, { title: 'Save your Trainer Card', defaultPath: 'trainer-card.png', filters: [{ name: 'PNG image', extensions: ['png'] }] });
  if (result.canceled || !result.filePath) return false;
  fs.writeFileSync(result.filePath, image.toPNG());
  return true;
});
ipcMain.handle('export-save', async event => {
  safeSender(event);
  const result = await dialog.showSaveDialog(home, { title: 'Export Pocodex collection', defaultPath: 'pocodex-collection.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (!result.canceled && result.filePath) fs.writeFileSync(result.filePath, JSON.stringify({ version: 1, exported_at: new Date().toISOString(), collection: latest.collection, pokedex: latest.pokedex }, null, 2));
});
app.on('second-instance', (_event, argv) => { if (!argv.includes('--autostart')) showHome(); });
app.on('before-quit', () => {
  quitting = true;
  if (positionTimer && buddy && !buddy.isDestroyed()) savePosition();
  try { if (ownsInstance) startup.pause(); } catch (failure) { console.error(JSON.stringify({ event: 'startup_pause_failed', code: failure.code })); }
  bridge?.close();
});
app.on('window-all-closed', () => { if (quitting) app.quit(); });
