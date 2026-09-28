const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('window restoration moves a disconnected monitor anchor into the work area', () => {
  assert.ok(fs.existsSync(path.join(__dirname, '../bridge.cjs')), 'Native bridge not implemented');
  const { clampBounds } = require('../bridge.cjs');
  assert.deepEqual(clampBounds({ x: 4000, y: -500, width: 200, height: 200 }, { x: 0, y: 0, width: 1280, height: 720 }), { x: 1080, y: 0, width: 200, height: 200 });
});

test('only documented renderer commands can reach the backend', () => {
  assert.ok(fs.existsSync(path.join(__dirname, '../bridge.cjs')), 'Native bridge not implemented');
  const { validCommand } = require('../bridge.cjs');
  assert.equal(validCommand('settings', { sound: false }), true);
  assert.equal(validCommand('add_source', { path: 'C:/' }), false);
  assert.equal(validCommand('quit', {}), false);
  assert.equal(validCommand('settings', 'invalid'), false);
});

test('connect and detect are the only new sidecar commands', () => {
  const { validCommand } = require('../bridge.cjs');
  assert.equal(validCommand('connect', { app: 'claude', enabled: true }), true);
  assert.equal(validCommand('detect', {}), true);
  assert.equal(validCommand('install_hooks', {}), false);
});
