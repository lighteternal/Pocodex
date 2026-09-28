const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');

test('catalog adapter preserves level rules and labels item/trade adaptations', async () => {
  const modulePath = path.join(__dirname, '../../scripts/companion_catalog.mjs');
  assert.ok(fs.existsSync(modulePath), 'Catalog adapter is not implemented');
  const { adaptRule } = await import(pathToFileURL(modulePath));
  assert.deepEqual(adaptRule([{ min_level: 16, trigger: { name: 'level-up' } }]), {
    min_level: 16, active_seconds: 0, requirement: 'Level 16', canonical: 'level-up', adapted: false,
  });
  const trade = adaptRule([{ trigger: { name: 'trade' } }]);
  assert.equal(trade.active_seconds, 3600);
  assert.equal(trade.adapted, true);
  assert.match(trade.requirement, /solo/i);
  const item = adaptRule([{ trigger: { name: 'use-item' }, item: { name: 'leaf-stone' } }]);
  assert.match(item.requirement, /leaf stone/);
  assert.equal(item.active_seconds, 3600);
});

test('unsupported evolution triggers cannot silently become level one', async () => {
  const modulePath = path.join(__dirname, '../../scripts/companion_catalog.mjs');
  assert.ok(fs.existsSync(modulePath), 'Catalog adapter is not implemented');
  const { adaptRule } = await import(pathToFileURL(modulePath));
  assert.throws(() => adaptRule([{ trigger: { name: 'unknown-future-rule' } }]), /Unsupported/);
});

test('move-use evolutions use an explicit companion adaptation', async () => {
  const { adaptRule } = await import(pathToFileURL(path.join(__dirname, '../../scripts/companion_catalog.mjs')));
  const result = adaptRule([{ trigger: { name: 'use-move' }, known_move: { name: 'rage-fist' } }]);
  assert.equal(result.adapted, true);
  assert.equal(result.active_seconds, 3600);
});

test('audio detects MP3 content labelled OGG upstream and rejects HTML', async () => {
  const catalog = await import(pathToFileURL(path.join(__dirname, '../../scripts/companion_catalog.mjs')));
  assert.equal(typeof catalog.audioFormat, 'function', 'Asset signature validator missing');
  assert.equal(catalog.audioFormat(Buffer.from('fffb94c400000000', 'hex')), 'mp3');
  assert.equal(catalog.audioFormat(Buffer.from('OggS0000')), 'ogg');
  assert.throws(() => catalog.audioFormat(Buffer.from('<html>error')), /Unsupported audio/);
});

test('bundled roster has connected evolution routes and intact attributed assets', () => {
  const folder = path.join(__dirname, '../assets');
  const catalog = JSON.parse(fs.readFileSync(path.join(folder, 'catalog.json')));
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json')));
  const species = new Map(catalog.species.map(p => [p.id, p]));
  assert.equal(species.size, catalog.species.length);
  for (let id = 1; id <= 151; id++) assert.ok(species.has(id), `Missing Kanto species ${id}`);
  for (const entry of manifest) {
    const data = fs.readFileSync(path.join(folder, entry.file));
    assert.equal(data.length, entry.bytes, entry.file);
    assert.equal(createHash('sha256').update(data).digest('hex'), entry.sha256, entry.file);
    assert.match(entry.url, /^https:\/\/raw\.githubusercontent\.com\/PokeAPI\//);
    assert.match(entry.rights, /unresolved/);
  }
  for (const pokemon of species.values()) {
    for (const file of [pokemon.sprite, pokemon.cry]) assert.ok(manifest.some(m => m.id === pokemon.id && m.file === file), `Missing asset ${file}`);
    for (const edge of pokemon.evolutions) {
      assert.ok(species.has(edge.to), `Missing evolution ${edge.to}`);
      assert.equal(species.get(edge.to).family, pokemon.family);
      assert.ok(edge.requirement && (edge.min_level >= 1 || edge.active_seconds > 0));
    }
    const visit = (id, visited = new Set()) => {
      assert.ok(!visited.has(id), `Evolution cycle at ${id}`);
      for (const edge of species.get(id).evolutions) visit(edge.to, new Set([...visited, id]));
    };
    visit(pokemon.id);
  }
});
