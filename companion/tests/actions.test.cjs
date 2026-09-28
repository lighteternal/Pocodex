const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const states = require('../ui/action-state.js');

test('every activity and reaction has an intentional action, without sleeping through input', () => {
  for (const [activity, reaction, elapsed, expected] of [
    ['working', '', 50000, 'Walk'], ['idle', '', 9999, 'Idle'], ['idle', '', 10000, 'Sleep'],
    ['waiting', '', 50000, 'Idle'], ['unknown', '', 50000, 'Idle'],
    ['working', 'pet', 0, 'Nod'], ['idle', 'berry', 50000, 'Eat'],
    ['idle', 'completed', 50000, 'Pose'], ['idle', 'evolve', 50000, 'Idle'],
  ]) assert.equal(states.select(activity, reaction, elapsed), expected);
  assert.equal(states.effect('waiting', ''), 'question');
  assert.equal(states.effect('idle', 'completed'), 'sparkle');
  assert.equal(states.effect('idle', ''), null);
});

test('action sheets are pinned, attributed and valid for the exact form', async () => {
  const folder = path.join(__dirname, '../assets');
  const pack = JSON.parse(fs.readFileSync(path.join(folder, 'actions.json')));
  const ponyta = pack.species['10162'];
  assert.equal(ponyta.folder, '0077/0001');
  assert.ok(ponyta.credits.includes('Jhony-Rex'));
  for (const name of ['Walk', 'Sleep', 'Eat', 'Nod', 'Pose']) assert.ok(ponyta.actions[name]);
  for (const entry of pack.manifest) {
    const data = fs.readFileSync(path.join(folder, entry.file));
    assert.equal(data.length, entry.bytes);
    assert.equal(createHash('sha256').update(data).digest('hex'), entry.sha256);
    assert.match(entry.url, /raw\.githubusercontent\.com\/(PMDCollab\/SpriteCollab|pret\/pokeemerald|pret\/pokefirered)\/[0-9a-f]{40}\//);
  }
  // Professor Oak is FireRed's own intro art, pinned like every other file.
  assert.deepEqual(pack.intro.oak, { file: 'intro-oak.png', width: 64, height: 96 });
  assert.ok(pack.manifest.find(entry => entry.file === 'intro-oak.png').url.includes(`pret/pokefirered/${pack.intro_revision}/`));
  const { formEntry, parseActions } = await import(pathToFileURL(path.join(__dirname, '../../scripts/companion_actions.mjs')));
  assert.equal(formEntry({ species_id: 20, slug: 'raticate-totem-alola', default: false }, { '0020': { subgroups: { '0001': { name: 'Alola', canon: true } } } }), null);
  assert.throws(() => parseActions('<Anim><Name>Walk</Name><CopyOf>Missing</CopyOf></Anim>'), /Invalid animation alias/);
  for (const form of Object.values(pack.species)) {
    assert.ok(form.credits.length);
    for (const action of Object.values(form.actions)) {
      assert.ok(action.durations.every(d => d > 0));
      assert.ok([1, 8].includes(action.directions));
      assert.ok(pack.manifest.some(entry => entry.file === action.file));
    }
  }
});
