const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// intro.js is a browser script: load it into a bare context with just what act() and render() touch.
function load(reduced = true) {
  const context = { performance, setTimeout, matchMedia: () => ({ matches: reduced }), cancelAnimationFrame() {}, requestAnimationFrame() {},
    document: { activeElement: null, querySelector: () => null } };
  vm.createContext(context);
  vm.runInContext(`${fs.readFileSync(path.join(__dirname, '../ui/intro.js'), 'utf8')}\nglobalThis.intro = intro;`, context);
  const state = { settings: { onboarding: false, reduced_motion: reduced }, trainer: { name: 'Red' }, roster: [] }, calls = [];
  context.intro.init({ state: () => state, render() {}, escape: s => s, egg: () => '', sprite: () => '', connectRows: () => '',
    command: async (...args) => { calls.push(args); return state; }, connectChosen: async () => { calls.push(['connectChosen']); return true; } });
  const scene = () => context.intro.render().match(/data-scene="(\w+)"/)[1];
  return { intro: context.intro, scene, calls };
}

test('clicking the text box never skips choosing apps or naming, and never runs past the end', async () => {
  const { intro, scene, calls } = load();
  await intro.act('skip');
  assert.equal(scene(), 'connect');
  for (let i = 0; i < 3; i++) await intro.act('next');
  assert.equal(scene(), 'connect');
  await intro.act('connect');
  assert.equal(scene(), 'name');
  await intro.act('next');
  assert.equal(scene(), 'name');
  await intro.act('name', 'Blue');
  assert.equal(scene(), 'farewell');
  await intro.act('next');
  assert.equal(scene(), 'farewell');
  assert.equal(JSON.stringify(calls), JSON.stringify([['connectChosen'], ['trainer', { name: 'Blue' }]]));
});

test('story pages still turn with the text box, and the first press only finishes the sentence', async () => {
  const { intro, scene } = load(false);
  const first = intro.render().match(/data-step="(\d+)"/)[1];
  await intro.act('next');
  assert.equal(intro.render().match(/data-step="(\d+)"/)[1], first);
  await intro.act('next');
  assert.equal(intro.render().match(/data-step="(\d+)"/)[1], String(Number(first) + 1));
  assert.equal(scene(), 'professor');
});
