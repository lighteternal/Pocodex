const { test } = require('node:test');
const assert = require('node:assert/strict');
const layout = require('../ui/sprite-layout.js');

// Measured from the pinned Pikachu sheets: PMD frames pad the body differently per action.
const pikachu = {
  actions: {
    Idle: { width: 40, height: 56, directions: 8 }, Walk: { width: 32, height: 40, directions: 8 },
    Sleep: { width: 32, height: 40, directions: 1 }, Eat: { width: 24, height: 48, directions: 1 },
  },
  boxes: {
    Idle: [{ row: 0, x0: 11, y0: 3, x1: 30, y1: 32 }], Walk: [{ row: 2, x0: 5, y0: 0, x1: 26, y1: 25 }, { row: 6, x0: 5, y0: 0, x1: 26, y1: 25 }],
    Sleep: [{ row: 0, x0: 8, y0: 3, x1: 31, y1: 26 }], Eat: [{ row: 0, x0: 2, y0: 3, x1: 23, y1: 28 }],
  },
};

test('one scale per form, so changing action never resizes the Pokemon', () => {
  const plan = layout.plan(pikachu.actions, pikachu.boxes, 128, 112, 1);
  assert.equal(plan.scale, 3);
  for (const [name, boxes] of Object.entries(pikachu.boxes)) for (const box of boxes) {
    const spot = layout.place(plan, pikachu.actions[name], box, 128);
    assert.equal(spot.y + (box.y1 + 1) * plan.scale, plan.foot, `${name} feet rest on the ground line`);
  }
});

test('small forms fill the view with whole-pixel scaling; the old frame-fit left them at ~half height', () => {
  const plan = layout.plan(pikachu.actions, pikachu.boxes, 128, 112, 1);
  const idle = pikachu.boxes.Idle[0];
  assert.ok((idle.y1 + 1 - idle.y0) * plan.scale >= 112 * 0.7);
  assert.ok(Number.isInteger(plan.scale));
  assert.equal(layout.plan(pikachu.actions, pikachu.boxes, 160, 140, 1.25).scale, 3);
});

test('large forms shrink smoothly but never below the tallest action fitting the view', () => {
  const actions = { Idle: { width: 96, height: 104, directions: 8 }, Sleep: { width: 40, height: 64, directions: 1 } };
  const boxes = { Idle: [{ row: 0, x0: 36, y0: 4, x1: 60, y1: 56 }], Sleep: [{ row: 0, x0: 3, y0: 2, x1: 38, y1: 44 }] };
  const plan = layout.plan(actions, boxes, 128, 112, 1);
  assert.ok(plan.scale > 0.94, 'bigger than the old frame-based scale');
  assert.ok(53 * plan.scale <= 112 * 0.82);
});

test('a jumping action caps the shared scale instead of clipping its head', () => {
  const actions = { Idle: { width: 32, height: 32, directions: 8 }, Walk: { width: 32, height: 64, directions: 8 } };
  const boxes = { Idle: [{ row: 0, x0: 8, y0: 8, x1: 23, y1: 27 }], Walk: [{ row: 2, x0: 8, y0: 0, x1: 23, y1: 45 }, { row: 6, x0: 8, y0: 0, x1: 23, y1: 45 }] };
  const plan = layout.plan(actions, boxes, 128, 112, 1);
  for (const box of boxes.Walk) assert.ok(layout.place(plan, actions.Walk, box, 128).y + box.y0 * plan.scale >= 0);
});

test('walking patrol stays inside the view on both directions', () => {
  const plan = layout.plan(pikachu.actions, pikachu.boxes, 128, 112, 1);
  const amp = layout.patrol(plan, pikachu.actions.Walk, pikachu.boxes.Walk, 128, 1);
  assert.ok(amp > 0);
  for (const box of pikachu.boxes.Walk) {
    const { x } = layout.place(plan, pikachu.actions.Walk, box, 128);
    assert.ok(x + box.x0 * plan.scale - amp >= 0);
    assert.ok(x + (box.x1 + 1) * plan.scale + amp <= 128);
  }
});

test('bounds are the union of every frame in the requested direction row', () => {
  const sheet = { width: 4, height: 3, durations: [1, 1] };
  const data = new Uint8ClampedArray(8 * 6 * 4);
  const opaque = (x, y) => { data[(y * 8 + x) * 4 + 3] = 255; };
  opaque(1, 1); opaque(6, 2); opaque(0, 4);
  assert.deepEqual(layout.bounds(data, 8, sheet, 0), { x0: 1, y0: 1, x1: 2, y1: 2 });
  assert.deepEqual(layout.bounds(data, 8, sheet, 1), { x0: 0, y0: 1, x1: 0, y1: 1 });
});

test('evolution shows exactly one form per frame, then settles on the new form', () => {
  const at = ms => layout.evolution(ms);
  assert.deepEqual(at(0), { form: 'before', white: 0 });
  assert.equal(at(599).form, 'before');
  const flicker = new Set();
  for (let ms = 600; ms < 2200; ms += 10) { const frame = at(ms); flicker.add(frame.form); assert.equal(frame.white, 1); }
  assert.deepEqual([...flicker].sort(), ['after', 'before']);
  assert.deepEqual(at(2200), { form: 'after', white: 1 });
  assert.equal(at(2800).form, 'after');
  assert.ok(at(2800).white > 0 && at(2800).white < 1);
  assert.deepEqual(at(3200), { form: 'after', white: 0 });
  assert.deepEqual(at(9000), { form: 'after', white: 0 });
});

test('battle sheets never change the desktop buddy size', () => {
  const withBattle = { actions: { ...pikachu.actions, Attack: { width: 64, height: 64, directions: 8 } },
    boxes: { ...pikachu.boxes, Attack: [{ row: 0, x0: 0, y0: 0, x1: 63, y1: 63 }] } };
  const buddy = layout.buddyActions(withBattle.actions);
  assert.deepEqual(Object.keys(buddy).sort(), ['Eat', 'Idle', 'Sleep', 'Walk']);
  const boxes = Object.fromEntries(Object.keys(buddy).map(name => [name, withBattle.boxes[name]]));
  assert.equal(layout.plan(buddy, boxes, 128, 112, 1).scale, layout.plan(pikachu.actions, pikachu.boxes, 128, 112, 1).scale);
});
