const path = require('node:path');
const fs = require('node:fs');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);

function startupController(app, profile, launchArgs) {
  const root = path.join(__dirname, '..');
  const executable = app.isPackaged ? path.join(process.resourcesPath, 'runtime', 'pocodex-core.exe') : path.join(root, '.venv', 'Scripts', 'python.exe');
  const prefix = app.isPackaged ? ['--startup'] : ['-m', 'observatory.companion.startup'];
  const watcher = app.isPackaged ? [path.join(process.resourcesPath, 'runtime', 'pocodex-watcher.exe'), '--watch', '--resume']
    : [path.join(root, '.venv', 'Scripts', 'pythonw.exe'), '-m', 'observatory.companion.startup', '--watch', '--resume'];
  const launch = [process.execPath, ...(app.isPackaged ? [] : [__dirname]), `--profile=${profile}`, '--autostart', ...launchArgs];
  let busy = false;
  async function configure(enabled) {
    if (busy && enabled !== undefined) throw new Error('Startup is still updating. Try again in a moment.');
    if (enabled !== undefined) busy = true;
    try {
      const args = [...prefix, '--profile', profile, '--configure', enabled === undefined ? 'status' : enabled ? 'enable' : 'disable'];
      if (enabled) args.push('--launch-json', JSON.stringify(launch), '--watcher-json', JSON.stringify(watcher));
      const { stdout } = await run(executable, args, { cwd: root, windowsHide: true, timeout: 20000, maxBuffer: 16384 });
      return JSON.parse(stdout);
    } catch (cause) {
      throw new Error('Could not update Windows startup. Check that Pocodex is installed and your startup settings are writable.', { cause });
    } finally { if (enabled !== undefined) busy = false; }
  }
  function resume() {
    fs.rmSync(path.join(profile, 'startup-paused'), { force: true });
    const child = spawn(watcher[0], [...watcher.slice(1).filter(arg => arg !== '--resume'), '--profile', profile, '--skip-current'], {
      cwd: root, windowsHide: true, detached: true, stdio: 'ignore',
    });
    child.on('error', failure => console.error(JSON.stringify({ event: 'startup_watcher_launch_failed', code: failure.code })));
    child.unref();
  }
  function pause() { fs.writeFileSync(path.join(profile, 'startup-paused'), ''); }
  return { configure, resume, pause };
}

module.exports = { startupController };
