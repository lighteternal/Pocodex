/* First-run intro in the style of FireRed's opening: Professor Oak explains Pocodex one text box at a time,
   then asks which apps to follow and the Trainer's name. Replayable from Settings. */
const intro = (() => {
  const TYPE_MS = 24;           // per character, close to the games' medium text speed
  const NIDORINO = 33;          // the Pokémon Oak shows off in FireRed's intro
  const LINES = [
    { scene: 'oak', text: 'Hello there! Welcome to the world of Pocodex!' },
    { scene: 'oak', text: 'My name is Oak. People call me the Pokémon Prof!' },
    { scene: 'pokemon', text: 'This world is inhabited far and wide by creatures called Pokémon. And, lately, by coding agents.' },
    { scene: 'egg', text: 'Here, an egg hatches while you work. Two active minutes with Codex or Claude Code, then you choose one of three Pokémon!' },
    { scene: 'egg', text: 'Your partner earns XP from each app on its own. Ten chats in one app still count once. No Rare Candy here!' },
    { scene: 'bubble', text: 'It lives on your desktop and rings like a Pokégear when an answer is ready or an agent needs you.' },
    { scene: 'hp', text: 'Its HP boxes show the allowance each app has left. When PP runs low, it warns you.' },
    { scene: 'ball', text: 'Need a break? Step into the tall grass! Five wild battles a day, Poké Balls to throw and eight Gym Badges to earn.' },
    { scene: 'connect', text: 'Now tell me. Which apps do you work with?' },
    { scene: 'name', text: 'And what is your name?' },
    { scene: 'farewell', text: name => `Right! So your name is ${name}! Your very own Pokémon legend is about to unfold! Let's go!` },
  ];
  const CONNECT = LINES.findIndex(line => line.scene === 'connect');
  let h, step = 0, started = performance.now(), skipTyping = false, replaying = false, leaving = false, busy = false, focusPending = false, frame = 0, oak;

  const init = helpers => { h = helpers; };
  const active = state => Boolean(state) && (!state.settings.onboarding || replaying);
  const reduced = () => h.state().settings.reduced_motion || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const text = () => { const line = LINES[step].text; return typeof line === 'function' ? line(h.state().trainer.name) : line; };
  const typed = () => reduced() || skipTyping || performance.now() - started >= text().length * TYPE_MS;
  const wait = ms => new Promise(resolve => setTimeout(resolve, reduced() ? 0 : ms));

  function go(next) {
    // Focus follows keyboard Trainers only, so a mouse click never leaves a ring on the text box.
    focusPending = LINES[next].scene === 'name' || Boolean(document.activeElement?.closest?.('.intro'));
    step = next; started = performance.now(); skipTyping = false;
    if (LINES[step].scene === 'pokemon') cry(NIDORINO);
    h.render();
  }
  function replay() { replaying = true; leaving = false; go(0); }
  function cry(id) {
    const state = h.state(), species = state.roster.find(p => p.id === id);
    if (!state.settings.sound || state.settings.quiet || !species?.cry) return;
    const sound = new Audio(`pocodex://assets/${species.cry}`);
    sound.volume = state.settings.volume;
    sound.play().catch(() => {});
  }

  // Scene props on the right-hand platform, all from real Pocodex parts.
  function prop(scene) {
    const state = h.state();
    if (scene === 'pokemon') {
      const species = state.roster.find(p => p.id === NIDORINO);
      return `<span class="intro-ball-open" aria-hidden="true"></span>${species ? h.sprite(species, 'intro-pokemon') : ''}`;
    }
    if (scene === 'egg') return `<span class="intro-egg">${h.egg()}</span>`;
    if (scene === 'bubble') return `<span class="intro-bubble">Ready to review</span><span class="intro-egg">${h.egg()}</span>`;
    if (scene === 'hp') {
      const box = (name, hp, tone) => `<div class="battle-box intro-hp" data-tone="${tone}"><div class="box-row"><span class="name">${name}</span><span class="level">5h</span></div><div class="hp-row"><span class="hp-label">HP</span><progress class="hp-bar" max="100" value="${hp}"></progress></div></div>`;
      // Illustrative numbers: hidden from screen readers, which hear Oak's sentence instead.
      return `<div class="intro-hp-stack" aria-hidden="true">${box('Codex', 72, 'high')}${box('Claude Code', 34, 'mid')}</div>`;
    }
    if (scene === 'ball') return '<span class="intro-grass" aria-hidden="true"></span><span class="intro-ball" aria-hidden="true"></span>';
    return '';
  }
  function controls(scene) {
    const state = h.state();
    if (scene === 'connect') {
      return `<div class="intro-controls">${h.connectRows()}<p class="fine">Progress and usage stay on this computer. No extra AI calls or token spend.</p><button class="game-button primary full" data-intro="connect" data-intro-primary ${busy ? 'disabled' : ''}>Next</button></div>`;
    }
    if (scene === 'name') {
      return `<form class="intro-controls intro-name" data-intro-name><label class="sr-only" for="intro-name">Your name</label><input id="intro-name" maxlength="12" autocomplete="off" spellcheck="false" value="${h.escape(state.trainer.name)}" data-intro-primary><button class="game-button primary" ${busy ? 'disabled' : ''}>OK</button></form>`;
    }
    if (scene === 'farewell') {
      return `<div class="intro-controls"><button class="game-button primary full" data-intro="finish" data-intro-primary ${busy ? 'disabled' : ''}>${replaying ? 'Back to Pocodex' : 'Start with an egg'}</button></div>`;
    }
    return '';
  }
  function render() {
    const { scene } = LINES[step], full = text(), story = step < CONNECT;
    const aside = ['pokemon', 'egg', 'bubble', 'hp', 'ball'].includes(scene);
    return `<section class="intro${leaving ? ' leaving' : ''}" aria-labelledby="intro-title">
      <h1 id="intro-title" class="sr-only">Welcome to Pocodex</h1>
      <div class="intro-stage" data-scene="${scene}" data-step="${step}">
        <span class="intro-platform oak-platform${aside ? ' aside' : ''}" aria-hidden="true"></span>
        <canvas class="intro-oak${aside ? ' aside' : ''}" width="64" height="96" data-intro-oak role="img" aria-label="Professor Oak"></canvas>
        ${aside && story ? `<span class="intro-platform prop-platform" aria-hidden="true"></span><div class="intro-prop">${prop(scene)}</div>` : ''}
        ${story ? '<button class="intro-skip" data-intro="skip">Skip intro</button>' : ''}
      </div>
      <div class="intro-box" data-intro-box>
        <p class="sr-only" aria-live="polite">${h.escape(full)}</p>
        <p class="intro-text" aria-hidden="true" data-intro-text>${h.escape(full)}</p>
        ${story ? '<button class="intro-next" data-intro="next" data-intro-primary aria-label="Next"></button>' : ''}
      </div>
      ${controls(scene)}
    </section>`;
  }

  // After each render: type the text out, paint Oak, and move focus once per step.
  function sync() {
    const box = document.querySelector('[data-intro-box]');
    if (!box) { cancelAnimationFrame(frame); return; }
    const element = box.querySelector('[data-intro-text]'), full = text();
    cancelAnimationFrame(frame);
    const tick = () => {
      const shown = typed() ? full.length : Math.floor((performance.now() - started) / TYPE_MS);
      if (element.dataset.shown !== String(shown)) {
        element.textContent = full.slice(0, shown);
        if (shown < full.length) { const rest = document.createElement('span'); rest.className = 'intro-rest'; rest.textContent = full.slice(shown); element.append(rest); }
        element.dataset.shown = shown;
      }
      box.classList.toggle('typed', shown >= full.length);
      if (shown < full.length) frame = requestAnimationFrame(tick);
    };
    tick();
    paintOak(document.querySelector('[data-intro-oak]'));
    // Poll-driven refreshes must not replay the step's entrance.
    if (!leaving) for (const animation of document.querySelector('.intro-stage')?.getAnimations({ subtree: true }) || []) animation.currentTime = performance.now() - started;
    if (focusPending) {
      focusPending = false;
      const primary = document.querySelector('[data-intro-primary]');
      primary?.focus({ preventScroll: true });
      if (primary instanceof HTMLInputElement) primary.select();
    }
  }
  async function paintOak(canvas) {
    if (!canvas || canvas.dataset.painted) return;
    canvas.dataset.painted = 'true';
    try {
      oak ||= (async () => {
        const response = await fetch('pocodex://app/assets/intro-oak.png');
        if (!response.ok) throw new Error('intro-oak.png');
        const image = await createImageBitmap(await response.blob());
        // FireRed's palette index zero is the backdrop, not part of the Professor.
        const surface = new OffscreenCanvas(image.width, image.height), c = surface.getContext('2d');
        c.drawImage(image, 0, 0);
        const pixels = c.getImageData(0, 0, image.width, image.height), data = pixels.data, [r, g, b] = data;
        for (let i = 0; i < data.length; i += 4) if (data[i] === r && data[i + 1] === g && data[i + 2] === b) data[i + 3] = 0;
        c.putImageData(pixels, 0, 0);
        return createImageBitmap(surface);
      })();
      const bitmap = await oak;
      const c = canvas.getContext('2d');
      c.clearRect(0, 0, canvas.width, canvas.height);
      c.drawImage(bitmap, 0, 0);
    } catch { canvas.hidden = true; }
  }

  // Clicks, the name form and the text box itself.
  async function act(kind, value) {
    if (busy || leaving) return;
    if (kind === 'skip') return go(CONNECT);
    if (!typed()) {  // The first press finishes the sentence, as in the games.
      skipTyping = true; sync();
      if (kind === 'next') return;
    }
    if (kind === 'next') return go(step + 1);
    busy = true; h.render();
    let advance = false;
    try {
      if (kind === 'connect') advance = await h.connectChosen();
      if (kind === 'name') {
        const name = String(value ?? '').trim();
        advance = !name || name === h.state().trainer.name || Boolean(await h.command('trainer', { name }));
      }
      if (kind === 'finish') {
        leaving = true; h.render();
        await wait(700);
        const done = replaying || Boolean(await h.command('settings', { onboarding: true, connections_reviewed: true }));
        leaving = false;
        if (done) { replaying = false; step = 0; }
      }
    } finally { busy = false; }
    if (advance) go(step + 1); else h.render();
  }

  // Enter or Space anywhere on the story pages works like the games' A button.
  function key(event) {
    if ((event.key === 'Enter' || event.key === ' ') && document.activeElement === document.body && step < CONNECT && document.querySelector('[data-intro-box]')) {
      event.preventDefault(); act('next');
    }
  }

  return { init, active, replay, render, sync, act, key };
})();
