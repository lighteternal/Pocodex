/* Decode the original asset, but own its playback clock instead of looping a GIF. */
const spriteMotion = (() => {
  let source, decoder, canvas, timer, sequence = 0, frame = 0;
  let mode = 'idle', reduced = false, loaded = false, count = 1;
  let restUntil = 0;
  const prefersReduced = matchMedia('(prefers-reduced-motion: reduce)');

  async function draw(index, generation) {
    const decoded = await decoder.decode({ frameIndex: index });
    try {
      if (generation !== sequence || !canvas?.isConnected) return 200;
      canvas.width = decoded.image.displayWidth;
      canvas.height = decoded.image.displayHeight;
      canvas.getContext('2d').drawImage(decoded.image, 0, 0);
      canvas.dataset.ready = 'true';
      canvas.dataset.frame = String(index);
      return Math.max(180, (decoded.image.duration || 100000) / 1000 * 2.5);
    } finally { decoded.image.close(); }
  }
  async function tick(generation) {
    if (generation !== sequence || !loaded || !canvas?.isConnected) return;
    try {
      const resting = reduced || prefersReduced.matches || (mode === 'idle' && Date.now() < restUntil);
      canvas.dataset.phase = resting ? 'rest' : 'playing';
      if (resting) frame = 0;
      const delay = resting && canvas.dataset.frame === '0' ? 500 : await draw(frame, generation);
      if (!resting) {
        frame = (frame + 1) % count;
        if (frame === 0 && mode === 'idle') restUntil = Date.now() + 10000;
      }
      timer = setTimeout(() => tick(generation), resting ? 500 : delay);
    } catch (failure) {
      if (generation === sequence) {
        canvas.dataset.error = 'true';
        document.dispatchEvent(new CustomEvent('sprite-error', { detail: 'The companion sprite could not load. Restart Pocodex.' }));
      }
    }
  }
  function stop() { clearTimeout(timer); ++sequence; decoder?.close(); decoder = null; source = null; loaded = false; }
  async function sync(nextCanvas, activity, reduce) {
    if (!nextCanvas) { stop(); return; }
    mode = activity; reduced = reduce;
    const nextSource = nextCanvas.dataset.spriteMotion;
    const changedCanvas = canvas !== nextCanvas;
    canvas = nextCanvas;
    if (source === nextSource) {
      if (changedCanvas && loaded) { clearTimeout(timer); tick(sequence); }
      return;
    }
    source = nextSource; loaded = false; frame = 0; restUntil = Date.now() + 10000;
    const generation = ++sequence;
    clearTimeout(timer); decoder?.close();
    try {
      const response = await fetch(nextSource);
      if (!response.ok) throw new Error('Sprite asset unavailable');
      const data = await response.arrayBuffer();
      if (generation !== sequence) return;
      decoder = new ImageDecoder({ data, type: nextSource.endsWith('.gif') ? 'image/gif' : 'image/png' });
      await decoder.tracks.ready;
      if (generation !== sequence) return;
      count = decoder.tracks.selectedTrack.frameCount;
      loaded = true; tick(generation);
    } catch (failure) {
      if (generation === sequence) document.dispatchEvent(new CustomEvent('sprite-error', { detail: 'The companion sprite could not load. Restart Pocodex.' }));
    }
  }
  return { sync, stop };
})();

/* PMD sheets use one row per direction and XML durations in 1/60-second frames. */
const actionMotion = (() => {
  let pack, loading, canvas, species, previous = null, activity = 'idle', reaction = '', reduced = false;
  let idleSince = performance.now(), activeAction = '', actionSince = 0, reactionAt = 0, timer, generation = 0;
  const sheets = new Map(), effects = new Map(), plans = new Map(), measured = new Map();
  const tint = new OffscreenCanvas(1, 1);
  const prefersReduced = matchMedia('(prefers-reduced-motion: reduce)');
  const fault = () => document.dispatchEvent(new CustomEvent('sprite-error', { detail: 'An action sprite could not load. Restart Pocodex or reinstall its asset pack.' }));
  const owner = file => file.split('-')[0];
  async function bitmap(file, cache, keyed = false) {
    if (!cache.has(file)) cache.set(file, (async () => {
      const response = await fetch(`pocodex://app/assets/${file}`);
      if (!response.ok) throw new Error(`Action asset unavailable: ${file}`);
      const image = await createImageBitmap(await response.blob());
      if (!keyed) return image;
      // Emerald's palette index zero is the transparent backdrop, not part of the effect.
      const surface = new OffscreenCanvas(image.width, image.height), ctx = surface.getContext('2d');
      ctx.drawImage(image, 0, 0); image.close();
      const pixels = ctx.getImageData(0, 0, surface.width, surface.height), data = pixels.data;
      const [r, g, b, alpha] = data;
      if (alpha) for (let i = 0; i < data.length; i += 4) if (data[i] === r && data[i + 1] === g && data[i + 2] === b) data[i + 3] = 0;
      ctx.putImageData(pixels, 0, 0);
      return createImageBitmap(surface);
    })());
    return cache.get(file);
  }
  async function drawEffects(token, still) {
    for (const target of document.querySelectorAll('[data-shared-effect]')) {
      const effect = pack.effects[target.dataset.sharedEffect];
      if (!effect) continue;
      const image = await bitmap(effect.file, effects, true);
      if (token !== generation || !target.isConnected) return;
      target.width = effect.width; target.height = effect.height;
      const index = still ? 0 : Math.floor((performance.now() - actionSince) / 220) % (effect.columns * effect.rows);
      target.getContext('2d').drawImage(image, (index % effect.columns) * effect.width, Math.floor(index / effect.columns) * effect.height,
        effect.width, effect.height, 0, 0, effect.width, effect.height);
      target.dataset.ready = 'true';
      target.dataset.frame = String(index);
    }
  }
  function measure(image, sheet, row) {
    const key = `${sheet.file}:${row}`;
    if (!measured.has(key)) {
      const surface = new OffscreenCanvas(image.width, image.height), ctx = surface.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(image, 0, 0);
      measured.set(key, spriteLayout.bounds(ctx.getImageData(0, 0, image.width, image.height).data, image.width, sheet, row));
    }
    return measured.get(key);
  }
  // Every sheet of the form is measured before the first draw, so the shared scale never changes mid-session.
  function planFor(form, width, height, dpr) {
    const key = `${form.id}:${width}x${height}`;
    if (!plans.has(key)) plans.set(key, (async () => {
      const actions = spriteLayout.buddyActions(pack.species[form.id].actions), boxes = {};
      for (const [name, sheet] of Object.entries(actions)) {
        const image = await bitmap(sheet.file, sheets);
        boxes[name] = spriteLayout.rows(name, sheet).map(row => ({ row, ...measure(image, sheet, row) }));
      }
      return spriteLayout.plan(actions, boxes, width, height, dpr);
    })());
    return plans.get(key);
  }
  function drawFrame(ctx, image, sheet, frame, row, x, y, scale, white) {
    const w = sheet.width, h = sheet.height;
    if (!white) { ctx.drawImage(image, frame * w, row * h, w, h, x, y, w * scale, h * scale); return; }
    tint.width = w; tint.height = h;
    const glow = tint.getContext('2d');
    glow.drawImage(image, frame * w, row * h, w, h, 0, 0, w, h);
    glow.globalCompositeOperation = 'source-atop';
    glow.fillStyle = `rgba(255, 255, 255, ${white})`;
    glow.fillRect(0, 0, w, h);
    ctx.drawImage(tint, 0, 0, w, h, x, y, w * scale, h * scale);
  }
  // Effects are placed from the drawn body, so a question mark sits by Pikachu's ears and Onix's head alike.
  function exposeBody(left, top, right, bottom, dpr) {
    const host = canvas.offsetParent;
    if (!host) return;
    const x = value => `${Math.round(canvas.offsetLeft + value / dpr)}px`, y = value => `${Math.round(canvas.offsetTop + value / dpr)}px`;
    const values = { '--body-left': x(left), '--body-right': x(right), '--body-mid': x((left + right) / 2),
      '--body-top': y(top), '--body-bottom': y(bottom), '--body-center': y((top + bottom) / 2) };
    for (const [name, value] of Object.entries(values)) if (host.style.getPropertyValue(name) !== value) host.style.setProperty(name, value);
  }
  async function tick(token) {
    if (token !== generation || !canvas?.isConnected || document.hidden) return;
    try {
      const still = reduced || prefersReduced.matches;
      const requested = companionActions.select(activity, reaction, performance.now() - idleSince);
      const available = pack.species[species.id]?.actions;
      const chosen = available?.[requested] ? requested : available?.Idle ? 'Idle' : null;
      // A repeated pet restarts its nod; an evolution starts at its own first frame.
      const clock = reaction ? `${requested}:${reactionAt}` : requested;
      if (activeAction !== clock) { activeAction = clock; actionSince = reaction ? reactionAt : performance.now(); }
      let delay = still || chosen === 'Sleep' ? 500 : 110;
      if (chosen) {
        const dpr = devicePixelRatio || 1;
        const width = Math.round((canvas.clientWidth || 128) * dpr), height = Math.round((canvas.clientHeight || 112) * dpr);
        const elapsed = performance.now() - actionSince;
        const evolving = reaction === 'evolve' && !still && previous && previous.id !== species.id && pack.species[previous.id]?.actions.Idle;
        const step = evolving ? spriteLayout.evolution(elapsed) : null;
        const form = step?.form === 'before' ? previous : species;
        const name = step ? 'Idle' : chosen;
        const formActions = pack.species[form.id].actions, sheet = formActions[name] || formActions.Idle;
        const [plan, image] = await Promise.all([planFor(form, width, height, dpr), bitmap(sheet.file, sheets)]);
        if (token !== generation || !canvas?.isConnected) return;
        const durations = sheet.durations.map(d => Math.max(name === 'Sleep' ? 500 : 110, d / 60 * 1000 * 1.5));
        const total = durations.reduce((a, b) => a + b, 0);
        let position = still || step ? 0 : name === 'Pose' ? Math.min(elapsed, total - 1) : elapsed % total;
        let frame = 0;
        while (frame < durations.length - 1 && position >= durations[frame]) position -= durations[frame++];
        const walking = name === 'Walk' && !still;
        const patrol = (elapsed % 10000) / 10000;
        const direction = sheet.directions === 8 && walking ? patrol < .5 ? 2 : 6 : 0;
        const boxes = plan.boxes[name] || plan.boxes.Idle;
        const box = boxes.find(b => b.row === direction) || boxes[0];
        const amplitude = walking ? spriteLayout.patrol(plan, sheet, boxes, width, dpr) : 0;
        const offset = Math.round((patrol < .5 ? patrol * 4 - 1 : 3 - patrol * 4) * amplitude);
        const spot = spriteLayout.place(plan, sheet, box, width), x = spot.x + offset, s = plan.scale;
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, width, height);
        ctx.imageSmoothingEnabled = !Number.isInteger(s);
        const left = x + box.x0 * s, right = x + (box.x1 + 1) * s;
        ctx.fillStyle = 'rgba(18, 37, 31, 0.22)';
        ctx.beginPath();
        ctx.ellipse((left + right) / 2, plan.foot, Math.max(6, (right - left) * 0.42), Math.max(2, 3 * dpr), 0, 0, Math.PI * 2);
        ctx.fill();
        drawFrame(ctx, image, sheet, frame, direction, x, spot.y, s, step?.white || 0);
        exposeBody(left, spot.y + box.y0 * s, right, plan.foot, dpr);
        Object.assign(canvas.dataset, { ready: 'true', grounded: 'true', frame: String(frame), direction: String(direction),
          action: step ? 'Evolve' : chosen, requestedAction: requested, spriteSheet: sheet.file, phase: still ? 'rest' : 'playing',
          mood: name === 'Walk' ? 'walking' : name === 'Sleep' ? 'sleeping' : 'awake', ...(step ? { evolutionForm: step.form } : {}) });
        if (!step) delete canvas.dataset.evolutionForm;
        if (step && elapsed < 3200) delay = 40;
      } else {
        // This exact form has no action pack. Keep its own pinned battle sprite.
        canvas.dataset.action = 'Battle'; canvas.dataset.requestedAction = requested;
        delete canvas.dataset.grounded;
        spriteMotion.sync(canvas, activity, still);
      }
      await drawEffects(token, still);
      if (token === generation) timer = setTimeout(() => tick(token), delay);
    } catch { if (token === generation) fault(); }
  }
  function release(keep) {
    for (const [file, promise] of sheets) if (!keep.has(owner(file))) { sheets.delete(file); promise.then(image => image.close()).catch(() => {}); }
    for (const key of plans.keys()) if (!keep.has(key.split(':')[0])) plans.delete(key);
    for (const key of measured.keys()) if (!keep.has(owner(key))) measured.delete(key);
  }
  async function sync(target, nextSpecies, nextActivity, nextReaction, reduce, previousSpecies = null, reactionStarted = 0) {
    reactionAt = reactionStarted;
    clearTimeout(timer);
    const token = ++generation;
    if (!target || !nextSpecies) { canvas = null; spriteMotion.stop(); return; }
    const nextPrevious = nextReaction === 'evolve' ? previousSpecies : null;
    if (species?.id !== nextSpecies.id || previous?.id !== nextPrevious?.id) {
      // Keep only the current form, plus the old form while its evolution plays.
      release(new Set([String(nextSpecies.id), ...(nextPrevious ? [String(nextPrevious.id)] : [])]));
      if (species?.id !== nextSpecies.id) { activeAction = ''; spriteMotion.stop(); }
    }
    if (activity !== nextActivity) idleSince = performance.now();
    canvas = target; species = nextSpecies; previous = nextPrevious; activity = nextActivity; reaction = nextReaction; reduced = reduce;
    try {
      loading ||= fetch('pocodex://app/assets/actions.json').then(response => {
        if (!response.ok) throw new Error('Action catalog unavailable');
        return response.json();
      });
      pack = await loading;
      if (token === generation) tick(token);
    } catch { if (token === generation) fault(); }
  }
  document.addEventListener('visibilitychange', () => {
    clearTimeout(timer);
    if (document.hidden) spriteMotion.stop();
    else if (canvas && pack) tick(++generation);
  });
  return { sync };
})();

// Still first frames make Reduce motion apply to the collection as well as the buddy.
const stillFrames = new Map();
async function paintStillSprites() {
  for (const target of document.querySelectorAll('[data-still-sprite]:not([data-ready])')) {
    if (!target.isConnected) continue;
    const filename = target.dataset.stillSprite;
    try {
      if (!stillFrames.has(filename)) stillFrames.set(filename, (async () => {
        const response = await fetch(`pocodex://app/assets/${filename}`);
        if (!response.ok) throw new Error('Sprite asset unavailable');
        const decoder = new ImageDecoder({ data: await response.arrayBuffer(), type: filename.endsWith('.gif') ? 'image/gif' : 'image/png' });
        try {
          const frame = await decoder.decode({ frameIndex: 0 });
          try { return await createImageBitmap(frame.image); } finally { frame.image.close(); }
        } finally { decoder.close(); }
      })());
      const bitmap = await stillFrames.get(filename);
      if (!target.isConnected) continue;
      target.width = bitmap.width; target.height = bitmap.height;
      target.getContext('2d').drawImage(bitmap, 0, 0);
      target.dataset.ready = 'true';
    } catch (failure) {
      document.dispatchEvent(new CustomEvent('sprite-error', { detail: 'A collection sprite could not load. Restart Pocodex.' }));
      return;
    }
  }
}
