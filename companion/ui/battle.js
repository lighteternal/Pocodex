/* Wild battles. The sidecar resolves every turn; this file stages what happened: a Gen 3-style top
   screen on canvas (sprites, particles, shakes, the Poké Ball) and a lower screen of text and menus. */
const battleScene = (() => {
  const ACTIONS = ['Idle', 'Attack', 'Hurt', 'Charge', 'Shoot', 'Hop'];
  // Two tones per type: particle core and edge.
  const TYPE = { normal: ['#fbf8ec', '#b9b39a'], fire: ['#ffd05a', '#e8492c'], water: ['#9fdcff', '#3a78e0'], electric: ['#fff49a', '#f0b818'],
    grass: ['#a8ec84', '#3b9a3a'], ice: ['#effeff', '#7fd4e8'], fighting: ['#ffc28a', '#b3322b'], poison: ['#e0a8f0', '#8a3fa0'],
    ground: ['#f0d898', '#a8823a'], flying: ['#ffffff', '#9fb2f0'], psychic: ['#ffc0d8', '#e8577f'], bug: ['#dcef7a', '#86a31f'],
    rock: ['#e0cc90', '#85703c'], ghost: ['#c2a8e4', '#4f3f7a'], dragon: ['#c0a8ff', '#5a3fd0'], dark: ['#9a8a80', '#3a2c25'],
    steel: ['#eef1f6', '#8e98ad'], fairy: ['#ffd8ea', '#e080a8'] };
  // Field palettes follow the buddy's scenery: sky top/bottom, far hills, ground, stripes, platform, platform rim.
  const FIELDS = {
    meadow: ['#bfe2ef', '#eaf6dc', '#8fbd78', '#a9d98a', '#9acb7b', '#cdeba4', '#74a456'],
    forest: ['#a9cfbf', '#dbeed2', '#3e6d4e', '#8cbb72', '#7cab63', '#abd28a', '#577f45'],
    pond: ['#b8e0f0', '#e2f5f2', '#6aa1a1', '#9ecaa9', '#8dba99', '#93d2e2', '#4a8fa8'],
    beach: ['#a8dbf7', '#f2f1d9', '#6fb6cf', '#f1dca2', '#e5cc88', '#f9e9bb', '#c6a667'],
    snow: ['#c7d8e7', '#f1f5f9', '#a7b7c7', '#eff5f9', '#dde7ef', '#ffffff', '#a4bccd'],
    ruins: ['#c8c1b1', '#e9e2d2', '#898373', '#bdb59b', '#ada58b', '#d2caaf', '#88806e'],
    camp: ['#f1c79f', '#f9e8c9', '#886856', '#b9a979', '#a99969', '#d1c191', '#877550'],
    volcano: ['#5b3a48', '#a95b48', '#392a30', '#7b5b51', '#6b4b41', '#9b6b59', '#583a30'],
  };
  let host, canvas, ctx, pack, data, sides = {}, particles = [], ball = null, flash = 0, shake = { until: 0, power: 0 };
  let rings = [];
  let raf = 0, open = false, playing = false, speedUp = false, audio = null, field = FIELDS.meadow, reduced = false;
  const sheets = new Map(), tint = new OffscreenCanvas(1, 1);

  const now = () => performance.now();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, reduced ? Math.min(ms, 60) : speedUp ? ms / 3 : ms));
  function tween(ms, step) {
    const length = reduced ? 1 : speedUp ? ms / 3 : ms, start = now();
    return new Promise(resolve => {
      const frame = () => { const t = Math.min(1, (now() - start) / length); step(t); t < 1 ? requestAnimationFrame(frame) : resolve(); };
      frame();
    });
  }
  const ease = t => 1 - (1 - t) ** 3;

  // Sound: real cries for Pokémon, short original synth for everything else.
  function allowed() { return state?.settings.sound && !state.settings.quiet; }
  function cry(form, low = false) {
    const species = state.roster.find(p => p.id === form);
    if (!allowed() || !species?.cry) return;
    const sound = new Audio(`pocodex://assets/${species.cry}`);
    sound.volume = state.settings.volume;
    if (low) { sound.preservesPitch = false; sound.playbackRate = 0.78; }
    sound.play().catch(() => {});
  }
  function tone(notes, type = 'square', gain = 0.08) {
    if (!allowed()) return;
    audio ||= new AudioContext();
    const at = audio.currentTime;
    for (const [frequency, start, length] of notes) {
      const oscillator = audio.createOscillator(), volume = audio.createGain();
      oscillator.type = type; oscillator.frequency.value = frequency;
      volume.gain.setValueAtTime(0, at + start);
      volume.gain.linearRampToValueAtTime(state.settings.volume * gain, at + start + 0.01);
      volume.gain.linearRampToValueAtTime(0, at + start + length);
      oscillator.connect(volume).connect(audio.destination);
      oscillator.start(at + start); oscillator.stop(at + start + length + 0.02);
    }
  }
  function noise(length, gain = 0.14, lowpass = 1800) {
    if (!allowed()) return;
    audio ||= new AudioContext();
    const buffer = audio.createBuffer(1, audio.sampleRate * length, audio.sampleRate), samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = (Math.random() * 2 - 1) * (1 - i / samples.length);
    const source = audio.createBufferSource(), filter = audio.createBiquadFilter(), volume = audio.createGain();
    source.buffer = buffer; filter.type = 'lowpass'; filter.frequency.value = lowpass; volume.gain.value = state.settings.volume * gain;
    source.connect(filter).connect(volume).connect(audio.destination); source.start();
  }
  const sfx = {
    sting: () => tone([[392, 0, .07], [523, .07, .07], [659, .14, .07], [784, .21, .07], [1047, .28, .18]]),
    hit: effect => noise(effect > 1 ? .22 : .12, effect > 1 ? .2 : effect < 1 ? .07 : .13, effect > 1 ? 900 : 1800),
    throw: () => noise(.25, .06, 3200),
    wobble: () => tone([[220, 0, .06], [180, .07, .05]], 'triangle', .1),
    click: () => tone([[1318, 0, .05], [1760, .06, .08]], 'square', .06),
    caught: () => tone([[523, 0, .12], [659, .13, .12], [784, .26, .12], [1047, .4, .32]], 'square', .07),
    level: () => tone([[659, 0, .1], [784, .1, .1], [988, .2, .1], [1319, .3, .28]], 'square', .06),
    run: () => tone([[523, 0, .06], [392, .07, .06], [262, .14, .12]], 'triangle', .1),
  };

  // Sprites -------------------------------------------------------------------------------------
  async function image(file) {
    if (!sheets.has(file)) sheets.set(file, fetch(`pocodex://app/assets/${file}`).then(r => { if (!r.ok) throw new Error(file); return r.blob(); }).then(createImageBitmap)
      .catch(failure => { sheets.delete(file); throw failure; }));
    return sheets.get(file);
  }
  function measure(bitmap, sheet, row) {
    const surface = new OffscreenCanvas(bitmap.width, bitmap.height), c = surface.getContext('2d', { willReadFrequently: true });
    c.drawImage(bitmap, 0, 0);
    return spriteLayout.bounds(c.getImageData(0, 0, bitmap.width, bitmap.height).data, bitmap.width, sheet, row);
  }
  async function load(fighterState, who) {
    const actions = pack.species[fighterState.id]?.actions || {};
    const art = {};
    for (const name of ACTIONS) {
      const sheet = actions[name] || actions.Idle;
      if (!sheet) continue;
      const bitmap = await image(sheet.file);
      // The wild Pokémon faces you (down-left); yours shows its back, facing up-right.
      const row = sheet.directions === 8 ? (who === 'wild' ? 7 : 3) : 0;
      art[name] = { sheet, bitmap, row, box: measure(bitmap, sheet, row) };
    }
    const still = state.roster.find(p => p.id === fighterState.id)?.sprite;
    if (!art.Idle && still) {
      // A few forms have no action sheet: they battle as their Pokédex sprite, one still frame.
      const bitmap = await image(still), sheet = { width: bitmap.width, height: bitmap.height, durations: [60] };
      art.Idle = { sheet, bitmap, row: 0, box: measure(bitmap, sheet, 0) };
    }
    const idle = art.Idle?.box;
    const height = idle ? idle.y1 + 1 - idle.y0 : 32;
    const target = (who === 'wild' ? 0.27 : 0.33) * canvas.height;
    return { who, id: fighterState.id, name: fighterState.name, level: fighterState.level, max: fighterState.max_hp, hp: fighterState.hp,
      shown: fighterState.hp, art, scale: Math.max(1, Math.min(6, Math.round(target / height))), action: 'Idle', since: now(), once: false,
      dx: 0, dy: 0, alpha: 1, white: 0, grow: 1, visible: true, blinkUntil: 0 };
  }
  const foot = who => who === 'wild' ? { x: canvas.width * 0.735, y: canvas.height * 0.37 } : { x: canvas.width * 0.27, y: canvas.height * 0.8 };
  function play(side, action, once = true) { side.action = side.art[action] ? action : 'Idle'; side.since = now(); side.once = once; }
  function frameOf(side) {
    const art = side.art[side.action] || side.art.Idle, durations = art.sheet.durations.map(d => d / 60 * 1000);
    const total = durations.reduce((a, b) => a + b, 0), elapsed = now() - side.since;
    if (side.once && elapsed >= total) { side.action = 'Idle'; side.since = now(); side.once = false; return frameOf(side); }
    let position = reduced ? 0 : elapsed % total, frame = 0;
    while (frame < durations.length - 1 && position >= durations[frame]) position -= durations[frame++];
    return { art, frame };
  }
  function drawSide(side) {
    if (!side?.visible || side.alpha <= 0 || side.grow <= 0 || !side.art.Idle) return;
    if (side.blinkUntil > now() && Math.floor(now() / 70) % 2) return;
    const { art, frame } = frameOf(side), { sheet, bitmap, row, box } = art;
    const s = side.scale * side.grow, base = foot(side.who);
    const x = Math.round(base.x + side.dx - sheet.width / 2 * s), y = Math.round(base.y + side.dy - (box.y1 + 1) * s);
    ctx.globalAlpha = side.alpha;
    if (side.white > 0) {
      tint.width = sheet.width; tint.height = sheet.height;
      const t = tint.getContext('2d');
      t.drawImage(bitmap, frame * sheet.width, row * sheet.height, sheet.width, sheet.height, 0, 0, sheet.width, sheet.height);
      t.globalCompositeOperation = 'source-atop'; t.fillStyle = `rgba(255,255,255,${side.white})`; t.fillRect(0, 0, sheet.width, sheet.height);
      ctx.drawImage(tint, 0, 0, sheet.width, sheet.height, x, y, sheet.width * s, sheet.height * s);
    } else {
      ctx.drawImage(bitmap, frame * sheet.width, row * sheet.height, sheet.width, sheet.height, x, y, sheet.width * s, sheet.height * s);
    }
    ctx.globalAlpha = 1;
  }

  // Field, platforms, ball and particles -----------------------------------------------------------
  function platform(cx, cy, rx, ry) {
    ctx.fillStyle = field[6]; ctx.beginPath(); ctx.ellipse(cx, cy + ry * .35, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = field[5]; ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
  }
  function drawField() {
    const w = canvas.width, h = canvas.height, u = Math.max(2, Math.round(w / 160));
    const horizon = Math.round(h * .42 / u) * u;
    for (let y = 0; y < horizon; y += u) {
      ctx.fillStyle = y / horizon < .5 ? field[0] : field[1]; ctx.fillRect(0, y, w, u);
    }
    ctx.fillStyle = field[2];
    for (let x = 0; x < w; x += u) {
      const hill = Math.round((Math.sin(x / w * 7.3) * .5 + Math.sin(x / w * 17.1) * .25 + 1) * h * .045 / u) * u;
      ctx.fillRect(x, horizon - hill, u, hill);
    }
    for (let y = horizon; y < h; y += u) {
      ctx.fillStyle = Math.floor((y - horizon) / (u * 3)) % 2 ? field[4] : field[3]; ctx.fillRect(0, y, w, u);
    }
    const wild = foot('wild'), ally = foot('ally');
    platform(wild.x, wild.y, w * .19, h * .055);
    platform(ally.x, ally.y, w * .24, h * .065);
  }
  function drawBall() {
    if (!ball) return;
    const r = canvas.width * .022;
    ctx.save(); ctx.translate(ball.x, ball.y); ctx.rotate(ball.spin || 0);
    ctx.fillStyle = '#e8412c'; ctx.beginPath(); ctx.arc(0, 0, r, Math.PI, 0); ctx.fill();
    ctx.fillStyle = '#f8f8f0'; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI); ctx.fill();
    ctx.strokeStyle = '#26262a'; ctx.lineWidth = Math.max(2, r * .22); ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-r, 0); ctx.lineTo(r, 0); ctx.stroke();
    ctx.fillStyle = '#f8f8f0'; ctx.beginPath(); ctx.arc(0, 0, r * .32, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
  }
  function burst(x, y, type, count = 18, spread = 1) {
    const [core, edge] = TYPE[type] || TYPE.normal, u = Math.max(2, Math.round(canvas.width / 160));
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2, speed = (1 + Math.random() * 3) * u * spread;
      particles.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - (type === 'fire' ? u : 0), life: 1,
        decay: .022 + Math.random() * .025, size: u * (2 + Math.floor(Math.random() * 2)), color: Math.random() < .6 ? core : edge, edge,
        gravity: ['rock', 'ground'].includes(type) ? u * .25 : type === 'fire' ? -u * .04 : 0, shape: type === 'electric' ? 'bolt' : type === 'psychic' || type === 'water' ? 'ring' : 'pixel' });
    }
  }
  function drawParticles() {
    for (const p of particles) {
      p.x += p.vx; p.y += p.vy; p.vy += p.gravity; p.vx *= .96; p.vy *= .96; p.life -= p.decay;
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = ctx.strokeStyle = p.color;
      if (p.shape === 'ring') { ctx.lineWidth = Math.max(1, p.size / 2); ctx.beginPath(); ctx.arc(p.x, p.y, p.size * 1.4, 0, Math.PI * 2); ctx.stroke(); }
      else if (p.shape === 'bolt') { ctx.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size * 3); ctx.fillRect(Math.round(p.x + p.size), Math.round(p.y + p.size * 2), p.size, p.size * 3); }
      else {
        // A darker rim keeps pale particles readable against the sky.
        const border = Math.max(1, Math.round(p.size / 3));
        ctx.fillStyle = p.edge; ctx.fillRect(Math.round(p.x) - border, Math.round(p.y) - border, p.size + border * 2, p.size + border * 2);
        ctx.fillStyle = p.color; ctx.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
      }
    }
    ctx.globalAlpha = 1;
    particles = particles.filter(p => p.life > 0);
    // Contact: a white star that pops, and a ring that spreads in the move's colour.
    for (const r of rings) {
      r.life -= .06;
      const grow = 1 - r.life, u = Math.max(2, Math.round(canvas.width / 160));
      ctx.globalAlpha = Math.max(0, r.life);
      ctx.strokeStyle = r.color; ctx.lineWidth = u * 1.5;
      ctx.beginPath(); ctx.ellipse(r.x, r.y, r.size * (0.4 + grow * 1.4), r.size * (0.25 + grow * 0.9), 0, 0, Math.PI * 2); ctx.stroke();
      if (r.life > .55) {
        ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#303028'; ctx.lineWidth = u * .8;
        const k = r.size * .55 * (1.3 - r.life);
        ctx.beginPath();
        for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4, len = i % 2 ? k * .45 : k; ctx.lineTo(r.x + Math.cos(a) * len, r.y + Math.sin(a) * len); }
        ctx.closePath(); ctx.fill(); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    rings = rings.filter(r => r.life > 0);
  }
  function draw() {
    if (!open) return;
    ctx.save();
    if (shake.until > now()) ctx.translate((Math.random() - .5) * shake.power, (Math.random() - .5) * shake.power * .5);
    drawField(); drawSide(sides.wild); drawSide(sides.ally); drawBall(); drawParticles();
    if (flash > 0) { ctx.fillStyle = `rgba(255,255,255,${flash})`; ctx.fillRect(0, 0, canvas.width, canvas.height); flash = Math.max(0, flash - .06); }
    ctx.restore();
    raf = requestAnimationFrame(draw);
  }

  // Lower screen ----------------------------------------------------------------------------------
  const $ = selector => host.querySelector(selector);
  let advance = null;
  async function say(text, hold = 700) {
    if (!text) return;
    const box = $('.battle-text');
    box.textContent = '';
    box.dataset.full = text;
    for (let i = 1; i <= text.length && !reduced && !speedUp; i++) { box.textContent = text.slice(0, i); await new Promise(r => setTimeout(r, 18)); if (box.dataset.full !== text) return; }
    box.textContent = text;
    await new Promise(resolve => { advance = resolve; setTimeout(resolve, reduced ? 350 : speedUp ? hold / 3 : hold); });
    advance = null;
  }
  // Same thresholds as the Home HP boxes and the games.
  const tone3 = fraction => fraction <= 0 ? 'out' : fraction <= .2 ? 'low' : fraction <= .5 ? 'mid' : 'high';
  function renderBox(side) {
    const el = $(`.battle-box.${side.who}`);
    if (!el) return;
    const fraction = side.shown / side.max;
    el.querySelector('.name').textContent = side.name;
    el.querySelector('.level').textContent = `Lv. ${side.level}`;
    const bar = el.querySelector('progress.hp-bar');
    bar.value = Math.max(0, Math.round(fraction * 100));
    el.dataset.tone = tone3(fraction);
    const numbers = el.querySelector('.numbers');
    if (numbers) numbers.textContent = `${Math.max(0, Math.round(side.shown))} / ${side.max}`;
  }
  async function drain(side, to) {
    const from = side.shown, span = Math.abs(from - to) / side.max;
    await tween(350 + 900 * span, t => { side.shown = from + (to - from) * t; renderBox(side); });
    side.shown = to; side.hp = to; renderBox(side);
  }
  function renderExp() {
    const partner = state.collection.find(p => p.id === state.battle?.ally.individual);
    const bar = $('.battle-box.ally progress.exp-bar');
    if (partner && bar) { bar.value = Math.round(partner.progress * 100); $('.battle-box.ally .level').textContent = `Lv. ${partner.level}`; }
  }

  function menu(mode = 'main') {
    const fight = state.battle, el = $('.battle-menu');
    if (!fight || playing) { el.innerHTML = ''; return; }
    if (fight.over) {
      el.innerHTML = `<button class="battle-choice wide continue" data-battle="close">Continue</button>`;
      el.querySelector('button').focus();
      return;
    }
    if (mode === 'fight') {
      const hint = e => e === 0 ? 'No effect' : e > 1 ? 'Super effective' : e < 1 ? 'Not very effective' : '';
      el.innerHTML = `<div class="move-grid">${fight.moves.map(m => `<button class="battle-choice move" data-type="${escape(m.type)}" data-battle="move" data-move="${escape(m.id)}"><strong>${escape(m.name)}</strong><small><span class="move-type">${escape(m.type)}</span> · ${m.power} power${hint(m.effect) ? ` · ${hint(m.effect)}` : ''}</small></button>`).join('')}</div><button class="battle-choice back" data-battle="back">Back</button>`;
    } else if (mode === 'bag') {
      el.innerHTML = `<div class="move-grid"><button class="battle-choice item" data-battle="ball" ${state.balls ? '' : 'disabled'}><strong>Poké Ball</strong><small>${state.balls} in your bag${state.balls ? '' : ' · win battles to earn more'}</small></button></div><button class="battle-choice back" data-battle="back">Back</button>`;
    } else {
      el.innerHTML = `<div class="battle-grid"><button class="battle-choice fight" data-battle="fight">Fight</button><button class="battle-choice bag" data-battle="bag">Bag</button><button class="battle-choice run" data-battle="run">Run</button><button class="battle-choice auto" data-battle="auto">Auto</button></div>`;
      $('.battle-text').textContent = lore.battle.prompt(sides.ally.name);
    }
    el.querySelector('button:not(:disabled)')?.focus();
  }

  // Choreography ----------------------------------------------------------------------------------
  const other = who => who === 'ally' ? 'wild' : 'ally';
  const title = side => side.who === 'wild' ? `the wild ${side.name}` : side.name;
  async function projectile(from, to, type) {
    const a = foot(from.who), b = foot(to.who), lift = canvas.height * .12;
    await tween(380, t => {
      const x = a.x + (b.x - a.x) * t, y = a.y - lift + (b.y - a.y) * t;
      burst(x, y, type, 3, .35);
    });
  }
  async function impact(target, step) {
    const at = foot(target.who), lift = target.art.Idle ? (target.art.Idle.box.y1 + 1 - target.art.Idle.box.y0) * target.scale / 2 : 30;
    for (let i = 0; i < Math.max(1, Math.min(step.hits, 5)); i++) {
      burst(at.x, at.y - lift, step.type, 30);
      rings.push({ x: at.x, y: at.y - lift, size: canvas.width * .09, life: 1, color: (TYPE[step.type] || TYPE.normal)[1] });
      sfx.hit(step.effect);
      if (step.effect > 1 || step.crit) shake = { until: now() + 320, power: canvas.width * (step.effect > 1 ? .025 : .015) };
      play(target, 'Hurt');
      target.blinkUntil = now() + 420;
      await sleep(step.hits > 1 ? 260 : 420);
    }
  }
  async function move(step) {
    const attacker = sides[step.who], target = sides[other(step.who)];
    await say(lore.battle.used(step.who, attacker.name, step.move), 380);
    const toward = step.who === 'ally' ? 1 : -1;
    if (step.class === 'physical') {
      play(attacker, 'Attack');
      await tween(240, t => { attacker.dx = Math.sin(t * Math.PI) * canvas.width * .06 * toward; attacker.dy = -Math.sin(t * Math.PI) * canvas.height * .03 * toward; });
    } else {
      play(attacker, 'Charge');
      const at = foot(attacker.who);
      for (let i = 0; i < 4; i++) { burst(at.x, at.y - 20, step.type, 4, .4); await sleep(70); }
      play(attacker, 'Shoot');
      await projectile(attacker, target, step.type);
    }
    attacker.dx = attacker.dy = 0;
    if (step.miss) {
      await tween(260, t => { target.dx = Math.sin(t * Math.PI) * canvas.width * .04 * toward; });
      target.dx = 0;
      await say(lore.battle.missed(step.who, attacker.name));
      return;
    }
    if (step.effect === 0) { await say(lore.battle.effect(0, title(target))); return; }
    await impact(target, step);
    await drain(target, step.target_hp);
    if (step.hits > 1) await say(lore.battle.hits(step.hits), 500);
    if (step.crit) await say(lore.battle.critical, 500);
    if (step.effect !== 1) await say(lore.battle.effect(step.effect, title(target)));
    if (step.heal) { await drain(attacker, attacker.shown + step.heal); await say(lore.battle.drained(other(step.who), target.name)); }
    if (step.recoil) { await drain(attacker, step.user_hp); await say(lore.battle.recoil(step.who, attacker.name)); }
  }
  async function faint(step) {
    const side = sides[step.who];
    cry(side.id, true);
    await tween(620, t => { side.dy = canvas.height * .12 * ease(t); side.alpha = 1 - t; });
    side.visible = false;
    await say(lore.battle.fainted(step.who, side.name));
  }
  async function throwBall(step) {
    const wild = sides.wild, start = { x: canvas.width * .12, y: canvas.height * .9 }, end = foot('wild');
    const top = end.y - (wild.art.Idle ? (wild.art.Idle.box.y1 + 1 - wild.art.Idle.box.y0) * wild.scale * .6 : 40);
    await say(lore.battle.threw, 200);
    sfx.throw();
    // A low arc: the ball stays clear of the wild Pokémon's HP box.
    await tween(520, t => { ball = { x: start.x + (end.x - start.x) * t, y: start.y + (top - start.y) * t - Math.sin(t * Math.PI) * canvas.height * .16, spin: t * 12 }; });
    flash = .9;
    await tween(300, t => { wild.white = Math.min(1, t * 2); wild.grow = 1 - t; });
    wild.visible = false;
    await tween(260, t => { ball = { x: end.x, y: top + (end.y - canvas.height * .03 - top) * ease(t), spin: 0 }; });
    for (let i = 0; i < step.shakes; i++) {
      await sleep(320);
      sfx.wobble();
      await tween(420, t => { ball.spin = Math.sin(t * Math.PI * 2) * .5; });
    }
    await sleep(260);
    if (step.caught) {
      sfx.click();
      burst(ball.x, ball.y, 'electric', 14, .8);
      burst(ball.x, ball.y, 'fairy', 14, .8);
      sfx.caught();
      await say(lore.battle.caught(wild.name), 1100);
      await say(lore.battle.registered(wild.name), 900);
    } else {
      flash = .8; ball = null;
      wild.visible = true;
      await tween(300, t => { wild.grow = t; wild.white = 1 - t; });
      await say(lore.battle.brokeFree(step.shakes));
    }
  }
  async function reward(step) {
    const ally = sides.ally;
    if (state.battle.over === 'lost') await say(lore.battle.lost);
    if (step.xp > 0) { renderExp(); await say(lore.battle.gained(ally.name, step.xp)); }
    if (step.levelled) { sfx.level(); play(ally, 'Hop'); await say(lore.battle.grew(ally.name, step.level), 1000); }
    if (step.ball) await say(lore.battle.ball);
  }
  async function intro() {
    const wild = sides.wild, ally = sides.ally;
    ally.visible = false;
    sfx.sting();
    host.querySelector('.battle-wipe').classList.add('go');
    await tween(750, t => { wild.dx = -canvas.width * .75 * (1 - ease(t)); });
    cry(wild.id);
    await say(lore.battle.appear(wild.name), 650);
    ball = { x: canvas.width * .08, y: canvas.height * .95 };
    sfx.throw();
    const end = foot('ally');
    await tween(420, t => { ball = { x: canvas.width * .08 + (end.x - canvas.width * .08) * t, y: canvas.height * .95 - Math.sin(t * Math.PI) * canvas.height * .3 + (end.y - canvas.height * .95) * t, spin: t * 10 }; });
    ball = null; flash = .7; ally.visible = true;
    await tween(360, t => { ally.grow = ease(t); ally.white = 1 - t; });
    cry(ally.id);
    await say(lore.battle.send(ally.name), 500);
  }
  async function run(steps) {
    playing = true; menu();
    try {
      for (const step of steps) {
        if (step.t === 'appear') await intro();
        else if (step.t === 'move') await move(step);
        else if (step.t === 'faint') await faint(step);
        else if (step.t === 'ball') await throwBall(step);
        else if (step.t === 'run') { sfx.run(); await say(lore.battle.ran); }
        else if (step.t === 'reward') await reward(step);
      }
    } finally { playing = false; speedUp = false; menu(); }
  }

  // Lifecycle ---------------------------------------------------------------------------------------
  async function start(fight) {
    open = true;
    host = document.querySelector('#battle');
    host.hidden = false;
    // The battle is modal: Home underneath leaves the keyboard and accessibility tree.
    document.querySelector('#app').inert = true;
    host.innerHTML = `<section class="battle" role="dialog" aria-modal="true" aria-label="Wild battle">
      <div class="battle-top"><canvas aria-hidden="true"></canvas>
        <div class="battle-box wild"><div class="box-row"><span class="name"></span><span class="level"></span></div><div class="hp-row"><span class="hp-label">HP</span><progress class="hp-bar" max="100" value="100" aria-label="Wild Pokémon HP"></progress></div></div>
        <div class="battle-box ally"><div class="box-row"><span class="name"></span><span class="level"></span></div><div class="hp-row"><span class="hp-label">HP</span><progress class="hp-bar" max="100" value="100" aria-label="Your partner's HP"></progress></div><div class="box-row numbers-row"><span class="numbers"></span></div><progress class="exp-bar" max="100" value="0" aria-label="Experience to next level"></progress></div>
        <div class="battle-wipe" aria-hidden="true"></div></div>
      <div class="battle-bottom"><p class="battle-text" aria-live="polite"></p><div class="battle-menu"></div></div></section>`;
    reduced = state.settings.reduced_motion || matchMedia('(prefers-reduced-motion: reduce)').matches;
    field = FIELDS[state.background] || FIELDS.meadow;
    canvas = host.querySelector('canvas');
    const width = Math.min(480, host.clientWidth - 16), dpr = devicePixelRatio || 1;
    canvas.style.width = `${width}px`; canvas.style.height = `${Math.round(width * 2 / 3)}px`;
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(width * 2 / 3 * dpr);
    ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = false;
    try {
      pack ||= await (await fetch('pocodex://app/assets/actions.json')).json();
      sides = { wild: await load(fight.wild, 'wild'), ally: await load(fight.ally, 'ally') };
    } catch (failure) {
      // Stay open until the sidecar drops the battle, so a refresh meanwhile cannot restart it; then Home is usable again.
      await command('battle_close');
      stop();
      error(`The wild battle could not load (${failure.message}). Try again from Home.`);
      return;
    }
    renderBox(sides.wild); renderBox(sides.ally); renderExp();
    host.addEventListener('click', onClick);
    host.addEventListener('keydown', onKey);
    raf = requestAnimationFrame(draw);
    // Resuming after a restart skips the entrance.
    if (fight.turn === 0) await run(fight.steps); else menu();
  }
  function stop() {
    open = false; cancelAnimationFrame(raf);
    document.querySelector('#app').inert = false;
    if (host) { host.hidden = true; host.innerHTML = ''; host.removeEventListener('click', onClick); host.removeEventListener('keydown', onKey); }
    particles = []; rings = []; ball = null; sides = {};
  }
  async function act(args) {
    // Lock the menu before asking the sidecar: a double-click must never send a second turn.
    playing = true; menu();
    let result;
    try { result = await command('battle_act', args); } finally { playing = false; }
    if (!result?.battle) { menu(); return; }
    await run(result.battle.steps);
  }
  async function onClick(event) {
    if (playing && event.target.closest('.battle-bottom, .battle-top')) { if (advance) advance(); else speedUp = true; return; }
    const button = event.target.closest('[data-battle]');
    if (!button || button.disabled) return;
    const choice = button.dataset.battle;
    if (choice === 'fight' || choice === 'bag') menu(choice);
    else if (choice === 'back') menu();
    else if (choice === 'move') act({ action: 'move', move: button.dataset.move });
    else if (choice === 'ball') act({ action: 'ball' });
    else if (choice === 'run') act({ action: 'run' });
    else if (choice === 'auto') act({ action: 'auto' });
    else if (choice === 'close') { button.disabled = true; command('battle_close'); }
  }
  function onKey(event) {
    if ((event.key === 'Enter' || event.key === ' ') && playing) { event.preventDefault(); if (advance) advance(); else speedUp = true; }
    if (event.key === 'Escape' && !playing && $('[data-battle="back"]')) { event.preventDefault(); menu(); }
  }
  // Called on every state update from app.js.
  function sync() {
    if (state.battle && !open) start(state.battle).catch(failure => error(failure.message));
    else if (!state.battle && open) stop();
  }
  return { sync, isOpen: () => open, isPlaying: () => playing };
})();
