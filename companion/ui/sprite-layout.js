/* PMD frames pad each action differently. Size and ground a form by its drawn pixels, once for all actions. */
const spriteLayout = (() => {
  const rows = (name, sheet) => name === 'Walk' && sheet.directions === 8 ? [2, 6] : [0];
  // Union of opaque pixels across every frame of one direction row, in frame-local coordinates.
  function bounds(data, imageWidth, sheet, row) {
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    const right = sheet.width * sheet.durations.length;
    for (let y = row * sheet.height; y < (row + 1) * sheet.height; y++) {
      for (let x = 0; x < right; x++) {
        if (!data[(y * imageWidth + x) * 4 + 3]) continue;
        const fx = x % sheet.width, fy = y - row * sheet.height;
        if (fx < x0) x0 = fx; if (fx > x1) x1 = fx; if (fy < y0) y0 = fy; if (fy > y1) y1 = fy;
      }
    }
    return x1 < 0 ? { x0: 0, y0: 0, x1: sheet.width - 1, y1: sheet.height - 1 } : { x0, y0, x1, y1 };
  }
  // Idle sets the size; every action must still fit. Whole-pixel scales keep pixel art even.
  function plan(actions, boxes, width, height, dpr) {
    const foot = height - Math.round(5 * dpr);
    const idle = (boxes.Idle || Object.values(boxes)[0])[0];
    const idleWidth = idle.x1 + 1 - idle.x0, idleHeight = idle.y1 + 1 - idle.y0;
    let cap = height * 0.86 / idleHeight;
    for (const [name, list] of Object.entries(boxes)) for (const box of list) {
      const half = actions[name].width / 2;
      cap = Math.min(cap, (foot - 1) / (box.y1 + 1 - box.y0), (width / 2 - 1) / Math.max(half - box.x0, box.x1 + 1 - half));
    }
    const ideal = Math.min(height * 0.72 / idleHeight, width * 0.62 / idleWidth);
    const whole = [Math.round(ideal), Math.floor(ideal), Math.floor(cap)].find(s => s >= 2 && s <= cap);
    return { scale: ideal >= 2 && whole ? whole : Math.min(ideal, cap), foot, boxes };
  }
  // Frames are centred horizontally on the body; each action's lowest pixel rests on the ground line.
  function place(layoutPlan, sheet, box, width) {
    return { x: Math.round(width / 2 - sheet.width / 2 * layoutPlan.scale), y: Math.round(layoutPlan.foot - (box.y1 + 1) * layoutPlan.scale) };
  }
  // One amplitude for both facings, so turning around never jumps.
  function patrol(layoutPlan, sheet, boxes, width, dpr) {
    let room = 17 * dpr;
    for (const box of boxes) {
      const { x } = place(layoutPlan, sheet, box, width);
      room = Math.min(room, x + box.x0 * layoutPlan.scale - 2, width - (x + (box.x1 + 1) * layoutPlan.scale) - 2);
    }
    return Math.max(0, Math.floor(room));
  }
  // Classic evolution: the old form glows, white silhouettes alternate faster, the new form settles.
  function evolution(ms) {
    if (ms < 600) return { form: 'before', white: ms / 600 };
    if (ms < 2200) {
      const p = (ms - 600) / 1600;
      return { form: Math.floor(3 * p + 11 * p * p) % 2 ? 'after' : 'before', white: 1 };
    }
    if (ms < 2400) return { form: 'after', white: 1 };
    if (ms < 3200) return { form: 'after', white: 1 - (ms - 2400) / 800 };
    return { form: 'after', white: 0 };
  }
  // The desktop buddy is sized from what it does on the desktop; battle sheets have their own stage.
  const BUDDY = ['Idle', 'Walk', 'Sleep', 'Eat', 'Pose', 'Nod'];
  const buddyActions = actions => Object.fromEntries(Object.entries(actions).filter(([name]) => BUDDY.includes(name)));
  return { rows, bounds, plan, place, patrol, evolution, buddyActions };
})();
if (typeof module !== 'undefined') module.exports = spriteLayout;
