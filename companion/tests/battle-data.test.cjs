const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const data = require('../data/battle.json');
const catalog = require('../data/catalog.json');

test('every form can battle with real stats, a catch rate and resolvable moves', () => {
  for (const form of catalog.species) {
    const entry = data.species[form.id];
    assert.ok(entry, `${form.name} has battle data`);
    assert.equal(entry.stats.length, 6);
    assert.ok(entry.stats.every(value => Number.isInteger(value) && value > 0), form.name);
    assert.ok(entry.capture >= 3 && entry.capture <= 255, form.name);
    for (const [move, level] of entry.learnset) {
      assert.ok(data.moves[move], `${form.name} knows ${move}`);
      assert.ok(level >= 0 && level <= 100);
    }
  }
  assert.ok(data.moves.struggle, 'Struggle is the fallback for forms with no damaging moves');
});

test('only moves the battle can resolve honestly are pinned', () => {
  for (const [id, move] of Object.entries(data.moves)) {
    assert.ok(['physical', 'special'].includes(move.class), id);
    assert.ok(Number.isInteger(move.power) && move.power > 0, id);
    for (const excluded of ['hyper-beam', 'solar-beam', 'explosion', 'fly', 'snore']) assert.notEqual(id, excluded);
  }
  assert.deepEqual(data.moves['fury-attack'].hits, [2, 5]);
});
