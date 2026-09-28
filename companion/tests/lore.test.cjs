const { test } = require('node:test');
const assert = require('node:assert/strict');
const lore = require('../ui/lore.js');

const pikachu = { id: 'a', species: { id: 25, name: 'Pikachu', types: ['electric'] } };
const eevee = { id: 'b', species: { id: 133, name: 'Eevee', types: ['normal'] } };

test('starting a new egg is not announced as a hatch', () => {
  const change = lore.companionChange({ active: pikachu, egg: null }, { active: null, egg: { seconds: 0, choices: [] } });
  assert.equal(change.kind, 'egg');
  assert.doesNotMatch(change.text, /hatch/i);
});

test('hatching, adopting and switching each get their own line', () => {
  assert.match(lore.companionChange({ active: null, egg: { choices: [] } }, { active: null, egg: { choices: [{ id: 1 }] } }).text, /hatching/);
  assert.equal(lore.companionChange({ active: null, egg: { choices: [{ id: 25 }] } }, { active: pikachu, egg: null }).text, 'Pikachu, I choose you!');
  assert.equal(lore.companionChange({ active: pikachu }, { active: eevee }).text, 'Eevee, I choose you!');
});

test('switching between two individuals of the same species still reacts', () => {
  assert.ok(lore.companionChange({ active: pikachu }, { active: { ...pikachu, id: 'c' } }));
});

test('an evolution or an unchanged companion needs no swap line', () => {
  assert.equal(lore.companionChange({ active: pikachu }, { active: { ...pikachu, species: { id: 26, name: 'Raichu' } } }), null);
  assert.equal(lore.companionChange({ active: pikachu }, { active: pikachu }), null);
  assert.equal(lore.companionChange(null, { active: pikachu }), null);
});

test('event lines stay useful: the actual state is always in the text', () => {
  assert.match(lore.eventLine({ kind: 'completed' }), /Ready to review/);
  assert.match(lore.eventLine({ kind: 'input_needed' }), /Need your input/);
  assert.match(lore.eventLine({ kind: 'low_allowance', remaining: 9 }), /9% Codex allowance left/);
  assert.match(lore.eventLine({ kind: 'limit_reached' }), /allowance used up/i);
  assert.equal(lore.eventLine({ kind: 'level_up', name: 'Pikachu', level: 12, berries: 1 }), 'Pikachu grew to Lv. 12! Got an Oran Berry!');
  assert.equal(lore.eventLine({ kind: 'level_up', name: 'Pikachu', level: 14, berries: 2 }), 'Pikachu grew to Lv. 14! Got 2 Oran Berries!');
  assert.equal(lore.eventLine({ kind: 'evolution_ready', name: 'Pikachu', to: 'Raichu' }), 'What? Pikachu is ready to evolve!');
  assert.equal(lore.eventLine({ kind: 'mystery' }), 'Something needs attention');
});

test('evolution speaks like the games and does not spoil the new form early', () => {
  assert.equal(lore.evolving('Squirtle'), 'What? Squirtle is evolving!');
  assert.equal(lore.evolved('Squirtle', 'Wartortle'), 'Congratulations! Squirtle evolved into Wartortle!');
});

test('pet lines follow the primary type and are stable for the same pet', () => {
  assert.match(lore.petLine(pikachu.species, 3), /\+1% XP$/);
  assert.equal(lore.petLine(pikachu.species, 3), lore.petLine(pikachu.species, 3));
  assert.notEqual(lore.petLine({ name: 'Charmander', types: ['fire'] }, 0), lore.petLine({ name: 'Squirtle', types: ['water'] }, 0));
  assert.match(lore.petLine({ name: 'Missingno', types: [] }, 0), /Missingno/);
});

test('egg checks move from patient to imminent as incubation grows', () => {
  const lines = [0, 40, 90, 115].map(lore.eggCheck);
  assert.equal(new Set(lines).size, 4);
  assert.match(lines[3], /any moment/);
});

test('permission prompts and double alerts say who needs you', () => {
  assert.equal(lore.eventLine({ kind: 'input_needed', reason: 'permission', app: 'claude' }), 'Your move, Trainer! Claude needs permission');
  assert.equal(lore.eventLine({ kind: 'input_needed', reason: 'question', app: 'claude' }), 'Your move, Trainer! Need your input');
  assert.equal(lore.bothApps(), 'Your move, Trainer! Codex and Claude need you');
});

test('battle lines follow the games, naming the wild side and each outcome', () => {
  const b = lore.battle;
  assert.equal(b.appear('Zubat'), 'A wild Zubat appeared!');
  assert.equal(b.send('Ivysaur'), 'Go! Ivysaur!');
  assert.equal(b.prompt('Ivysaur'), 'What will Ivysaur do?');
  assert.equal(b.used('wild', 'Zubat', 'Bite'), 'The wild Zubat used Bite!');
  assert.equal(b.used('ally', 'Ivysaur', 'Vine Whip'), 'Ivysaur used Vine Whip!');
  assert.equal(b.effect(2, 'Zubat'), "It's super effective!");
  assert.equal(b.effect(4, 'Zubat'), "It's super effective!");
  assert.equal(b.effect(0.5, 'Zubat'), "It's not very effective...");
  assert.equal(b.effect(0, 'the wild Geodude'), "It doesn't affect the wild Geodude...");
  assert.equal(b.effect(1, 'Zubat'), '');
  assert.equal(b.hits(3), 'Hit 3 times!');
  assert.equal(b.missed('wild', 'Zubat'), "The wild Zubat's attack missed!");
  assert.equal(b.fainted('wild', 'Zubat'), 'The wild Zubat fainted!');
  assert.deepEqual([0, 1, 2, 3].map(b.brokeFree), ['Oh no! The Pokémon broke free!', 'Aww! It appeared to be caught!', 'Aargh! Almost had it!', 'Gah! It was so close, too!']);
  assert.equal(b.caught('Zubat'), 'Gotcha! Zubat was caught!');
  assert.equal(b.gained('Ivysaur', 312), 'Ivysaur gained 312 EXP. Points!');
  assert.equal(b.grew('Ivysaur', 22), 'Ivysaur grew to Lv. 22!');
});

test('stopped and exhausted lines name the app they came from', () => {
  assert.equal(lore.eventLine({ kind: 'stopped', app: 'claude' }), 'Work paused. Claude is catching its breath');
  assert.equal(lore.eventLine({ kind: 'limit_reached', app: 'claude' }), 'Out of PP! Claude allowance used up');
  assert.equal(lore.eventLine({ kind: 'stopped' }), 'Work paused. Codex is catching its breath');
  assert.equal(lore.eventLine({ kind: 'low_allowance', app: 'claude', remaining: 9 }), 'PP running low: 9% Claude allowance left');
});

test('a treat that levels up announces the level, short enough for the buddy bubble', () => {
  const levelUp = { kind: 'level_up', name: 'Bulbasaur', level: 16, berries: 1 };
  assert.equal(lore.treatReaction(lore.berryLine, levelUp), 'Bulbasaur grew to Lv. 16! Got an Oran Berry!');
  assert.equal(lore.treatReaction(lore.berryLine, null), 'Munch! An Oran Berry. +20% XP');
});
