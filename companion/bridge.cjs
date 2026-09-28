const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { EventEmitter } = require('node:events');

const actions = new Set(['snapshot', 'adopt', 'refresh_choices', 'new_egg', 'switch', 'evolve', 'encounter', 'settings', 'acknowledge', 'shuffle_background', 'pet', 'berry', 'connect', 'detect', 'battle_start', 'battle_act', 'battle_close', 'trainer']);
function validCommand(action, args) {
  return actions.has(action) && args !== null && typeof args === 'object' && !Array.isArray(args) && JSON.stringify(args).length < 16384;
}
function clampBounds(bounds, area) {
  const width = Math.min(bounds.width, area.width), height = Math.min(bounds.height, area.height);
  return { x: Math.round(Math.max(area.x, Math.min(bounds.x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y + area.height - height))), width, height };
}

class Bridge extends EventEmitter {
  constructor(command, args, options) {
    super();
    this.pending = new Map();
    this.sequence = 0;
    this.state = null;
    this.child = spawn(command, args, { ...options, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on('line', line => {
      try {
        const message = JSON.parse(line);
        if (message.state) { this.state = message.state; this.emit('state', message); }
        if (this.pending.has(message.id)) {
          const pending = this.pending.get(message.id); this.pending.delete(message.id); clearTimeout(pending.timer);
          if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.state);
        }
      } catch { this.emit('fault', 'The local companion returned an invalid response. Restart Pocodex.'); }
    });
    // Do not mirror tracebacks or paths into the UI. Keep a bounded local diagnostic.
    this.diagnostic = '';
    this.child.stderr.on('data', chunk => { this.diagnostic = (this.diagnostic + chunk.toString()).slice(-4096); });
    this.child.once('error', error => this.fail(`Local companion could not start (${error.code || 'process error'}).`));
    this.child.once('exit', code => this.fail(`Local companion stopped (exit ${code}). Your saved collection is preserved.`));
  }
  fail(message) {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error(message)); }
    this.pending.clear();
    this.emit('fault', message);
  }
  request(action, args = {}) {
    return new Promise((resolve, reject) => {
      if (this.child.exitCode !== null || !this.child.stdin.writable) return reject(new Error('Local companion is disconnected. Restart Pocodex.'));
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('The local companion did not respond within 10 seconds.')); }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, action, args }) + '\n', error => {
        if (error && this.pending.has(id)) { clearTimeout(timer); this.pending.delete(id); reject(new Error('Cannot reach the local companion.')); }
      });
    });
  }
  close() {
    if (this.child.stdin.writable) this.child.stdin.end(JSON.stringify({ action: 'quit' }) + '\n');
    const timer = setTimeout(() => { if (this.child.exitCode === null) this.child.kill(); }, 2000);
    timer.unref();
  }
}

module.exports = { Bridge, clampBounds, validCommand };
