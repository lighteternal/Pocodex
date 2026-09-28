/* Pocodex renderer: local templates, no model calls or remote content. */
const api = window.pocodex;
const isBuddy = new URLSearchParams(location.search).get('view') === 'buddy';
const isUpdates = new URLSearchParams(location.search).get('view') === 'updates';
const isPreview = new URLSearchParams(location.search).has('preview');
document.title = (isBuddy ? 'Pocodex buddy' : isUpdates ? 'Pocodex updates' : 'Pocodex') + (isPreview ? ' — test collection' : '');
const appRoot = document.querySelector('#app');
const errorBox = document.querySelector('#error');
document.body.classList.toggle('buddy-window', isBuddy);
document.body.classList.toggle('updates-window', isUpdates);
let state, page = 'home', filter = '', dexScope = 'unlocked', selectedDex = null, selectedEvolution = null;
let audio, lastSound = 0, transient = '', transientId = null, transientTimer, seenEvents = new Set();
let lastMarkup = '';
let startupState = null, startupBusy = false, connectChoice = {}, connecting = false;
let reactionKind = '', reactionStarted = 0, previousForm = null, evolutionCryTimer, evolutionTextTimer, evolutionAudio;
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const markdown = window.markdownit({ html: false, linkify: false, typographer: false });
// Previews are read-only: no navigation, embedded media, or message-provided HTML.
markdown.renderer.rules.link_open = () => '<span class="preview-link">';
markdown.renderer.rules.link_close = () => '</span>';
markdown.renderer.rules.image = (tokens, index) => escape(tokens[index].content);
const messagePreview = text => `<div class="message-preview">${markdown.render(String(text ?? '').slice(0, 600))}</div>`;
const number = value => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value || 0);
const date = seconds => new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const minutes = seconds => `${Math.floor((seconds || 0) / 60)} min`;
const shortDate = seconds => new Date(seconds * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const icon = name => `<img class="icon" src="icons/${name}.svg" alt="" aria-hidden="true">`;
const sprite = (species, className = '') => state?.settings.reduced_motion || matchMedia('(prefers-reduced-motion: reduce)').matches
  ? `<canvas class="sprite ${className}" data-still-sprite="${escape(species.sprite)}" role="img" aria-label="${escape(species.name)}"></canvas>`
  : `<img class="sprite ${className}" src="pocodex://assets/${escape(species.sprite)}" alt="${escape(species.name)}" draggable="false" loading="lazy">`;
const egg = () => '<img class="egg" src="egg.svg" alt="An unhatched egg" draggable="false">';
const liveSprite = (species, className = '') => `<canvas class="sprite action-sprite ${className}" data-sprite-motion="pocodex://app/assets/${escape(species.sprite)}" role="img" aria-label="${escape(species.name)}"></canvas>`;
const sharedEffect = name => `<canvas data-shared-effect="${name}" aria-hidden="true"></canvas>`;
const progress = (value, label) => `<progress max="1" value="${Math.max(0, Math.min(1, value))}" aria-label="${escape(label)}"></progress>`;
const soundButton = () => `<button id="sound-toggle" class="icon-button" data-action="mute" aria-label="${state.settings.sound ? 'Mute sound' : 'Enable sound'}" title="${state.settings.sound ? 'Mute sound' : 'Enable sound'}">${icon(state.settings.sound ? 'speaker-high' : 'speaker-slash')}</button>`;

// Errors never cover navigation and can always be dismissed.
function error(message) { errorBox.innerHTML = `<p>${escape(message)}</p><button class="icon-button" data-dismiss-error aria-label="Dismiss message">${icon('x')}</button>`; errorBox.hidden = false; }
errorBox.addEventListener('click', event => { if (event.target.closest('[data-dismiss-error]')) errorBox.hidden = true; });
async function command(action, args = {}) {
  try { const result = await api.command(action, args); if (result) { state = result; render(); } errorBox.hidden = true; return result; }
  catch (failure) { error(failure.message.replace(/^Error invoking remote method '[^']+': Error: /, '')); return null; }
}
const cryEvents = { completed: 'completion_sound', input_needed: 'attention_sound', stopped: 'attention_sound',
  limit_reached: 'attention_sound', low_allowance: 'attention_sound', milestone: 'milestone_sound', evolution_ready: 'milestone_sound', badge: 'milestone_sound', pet: 'milestone_sound', berry: 'milestone_sound', evolve: 'milestone_sound' };
function playCry(event) {
  const preview = event === 'preview';
  if (!preview && (!Object.hasOwn(cryEvents, event) || !state?.settings[cryEvents[event]])) return;
  if (!state?.settings.sound || state.settings.quiet || !state.active?.species.cry) return;
  if (!preview && event !== 'evolve' && Date.now() - lastSound < 15000) return;
  audio?.pause(); audio = new Audio(`pocodex://assets/${state.active.species.cry}`);
  audio.volume = state.settings.volume; lastSound = Date.now();
  audio.play().catch(() => error('Sound could not play. Check your output device or mute sound.'));
}
function react(text, kind, ident = null, duration = 3500) {
  if (state.settings.quiet) return;
  clearTimeout(evolutionCryTimer); clearTimeout(evolutionTextTimer);
  evolutionAudio?.close(); evolutionAudio = null;
  reactionKind = kind;
  reactionStarted = performance.now();
  transient = text; transientId = ident; document.body.classList.add('celebrating'); render();
  clearTimeout(transientTimer);
  transientTimer = setTimeout(() => { transient = ''; reactionKind = ''; previousForm = null; document.body.classList.remove('celebrating'); render(); }, duration);
  if (isBuddy && kind === 'evolve') evolutionSound();
  else if (isBuddy) playCry(kind);
}
function evolutionSound() {
  clearTimeout(evolutionCryTimer);
  evolutionAudio?.close();
  if (!state.settings.sound || state.settings.quiet || !state.settings.milestone_sound) return;
  // Original short chime; no recording or extra asset download.
  evolutionAudio = new AudioContext();
  const context = evolutionAudio;
  [523.25, 659.25, 783.99, 1046.5].forEach((frequency, index) => {
    const oscillator = context.createOscillator(), gain = context.createGain();
    const start = context.currentTime + index * 0.16;
    oscillator.type = 'triangle'; oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(state.settings.volume * 0.12, start + 0.02);
    gain.gain.linearRampToValueAtTime(0, start + 0.3);
    oscillator.connect(gain); gain.connect(context.destination);
    oscillator.start(start); oscillator.stop(start + 0.31);
  });
  evolutionCryTimer = setTimeout(() => { context.close(); if (evolutionAudio === context) evolutionAudio = null; playCry('evolve'); }, 2400);
}
function reactionArt() {
  if (!state.active || state.settings.quiet) return '';
  const effect = companionActions.effect(state.telemetry.activity, reactionKind);
  // The forms themselves flicker inside the live sprite canvas; this layer only adds the ring and sparkles.
  if (reactionKind === 'evolve') return `<span class="reaction-art evolution-art" data-effect="evolve" aria-hidden="true"><span class="evolution-ring"></span><span class="evolution-sparkles">${sharedEffect('sparkle')}</span></span>`;
  if (effect === 'heart') return `<span class="reaction-art pet-art" data-effect="pet" aria-hidden="true">${[0, 1, 2].map(() => sharedEffect('heart')).join('')}</span>`;
  if (effect === 'berry') return `<span class="reaction-art berry-art" data-effect="berry" aria-hidden="true">${sharedEffect('berry')}<i></i><i></i><i></i></span>`;
  return effect ? `<span class="reaction-art status-art" data-effect="${effect}" aria-hidden="true">${sharedEffect(effect)}</span>` : '';
}
function wildGrass() {
  const left = state.battles_left, balls = state.balls;
  if (!left) return '<div class="wild-grass"><button class="game-button" disabled>Look for wild Pokémon</button><p class="fine">Your partner needs rest. Battles return tomorrow.</p></div>';
  return `<div class="wild-grass"><button class="game-button" data-action="battle">Look for wild Pokémon</button><p class="fine">${left} of 5 battles left today · ${balls} Poké ${balls === 1 ? 'Ball' : 'Balls'}</p></div>`;
}
function treatControls(active) {
  const { berries, pets_left: pets, next_pet_at: next } = state.treats;
  const maxed = active.level === 100;
  return `<div class="actions treats"><button data-action="pet" ${!pets || maxed ? 'disabled' : ''}>${icon('heart-pixel')}Pet <small>${pets}/10 left</small></button><button data-action="berry" ${!berries || maxed ? 'disabled' : ''}>${icon('berry-pixel')}Feed berry <small>Bag: ${berries}</small></button><button data-action="new_egg">New egg</button></div><p class="fine treat-rules">${maxed ? 'Lv. 100! Treats saved for your next companion.' : `Pet: +1% · Berry: +20% of a level.<br>${pets ? '10 pets per rolling hour.' : `Next pet at ${new Date(next * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`} One berry per new level.`}</p>`;
}
const eventText = lore.eventLine;
const appName = app => allowance.appName(app || 'codex');
const appTag = app => app ? `<span class="app-tag" data-app="${escape(app)}">${escape(appName(app))}</span>` : '';
const appActivity = { working: 'Working', waiting: 'Needs you', idle: 'Resting', unknown: 'Checking', off: 'Off' };
// Allowance as a battle status box: HP is the five-hour window, the thin blue bar is the week.
function hpBox(app) {
  const card = allowance.card(app, state.telemetry.apps, state.connections, state.now);
  const name = `<div class="hp-name"><strong>${appName(app)}</strong><span class="app-status" data-activity="${escape(card.activity)}">${appActivity[card.activity] || 'Resting'}</span></div>`;
  if (card.state === 'off') {
    return `<article class="hp-box" data-app="${app}" data-state="off">${name}<p class="hp-note">${card.found ? 'Found on this PC, not connected.' : 'Not found on this PC.'}</p>${card.found ? `<button class="game-button small" data-connect="${app}">Connect</button>` : ''}</article>`;
  }
  if (card.state === 'missing') {
    return `<article class="hp-box" data-app="${app}" data-state="missing">${name}<div class="hp-row"><span class="hp-label">HP</span><span class="hp-unknown">??</span></div><p class="hp-note">${escape(card.note)}</p></article>`;
  }
  const label = `${appName(app)}: ${card.hp}% of the ${card.window} allowance left`;
  return `<article class="hp-box" data-app="${app}" data-state="${card.state}" data-tone="${card.tone}">${name}
    <div class="hp-row"><span class="hp-label">HP</span><progress class="hp-bar" max="100" value="${card.hp}" aria-label="${escape(label)}"></progress></div>
    <div class="hp-numbers"><span><b>${card.hp}%</b> left · ${escape(card.window)}</span><span>${card.reset ? `Resets ${escape(card.reset)}` : ''}</span></div>
    ${card.week !== undefined ? `<div class="exp-row"><span>Week</span><progress class="exp-bar" max="100" value="${card.week}" aria-label="${appName(app)}: ${card.week}% of the weekly allowance left"></progress><span>${card.week}%</span></div>` : ''}
    ${card.note ? `<p class="hp-note">${escape(card.note)}</p>` : ''}</article>`;
}
const allowanceStrip = () => `<section class="hp-strip" aria-label="Allowance left">${hpBox('codex')}${hpBox('claude')}</section>`;
// Connect choices: pre-ticked for apps found on this PC; the user's own clicks win until confirmed.
function connectRows() {
  const rows = [['codex', 'Codex', 'Reads Codex session logs on this PC. Nothing in Codex changes.'],
    ['claude', 'Claude Code', `Adds Pocodex hooks and a status line to ${escape((state.connections?.claude?.path || '~/.claude') + '\\settings.json')}. Untick any time to remove them.`]];
  return rows.map(([app, label, detail]) => {
    const link = state.connections?.[app] || {};
    const checked = connectChoice[app] ?? (link.enabled || link.found);
    return `<div class="connect-row"><input id="connect-${app}" type="checkbox" data-choice="${app}" aria-describedby="connect-${app}-note" ${checked ? 'checked' : ''} ${link.found || link.enabled ? '' : 'disabled'}><span><label for="connect-${app}">${label}</label><small id="connect-${app}-note">${link.found || link.enabled ? detail : 'Not found on this PC.'}</small></span></div>`;
  }).join('');
}
async function connectChosen() {
  for (const app of ['codex', 'claude']) {
    const box = document.getElementById(`connect-${app}`);
    if (!box || box.disabled) continue;
    if (box.checked !== Boolean(state.connections?.[app]?.enabled) && !(await command('connect', { app, enabled: box.checked }))) {
      // The error explains the fix; untick the app so the next press can carry on without it.
      connectChoice[app] = Boolean(state.connections?.[app]?.enabled); render();
      return false;
    }
  }
  return true;
}
const connectCard = () => `<section class="connect-card" aria-labelledby="connect-title"><h2 id="connect-title">Connect your apps</h2><p class="fine">Your Pokémon grows with each connected app, and reacts when either one finishes or needs you.</p>${connectRows()}<div class="actions"><button class="game-button" data-action="connect-later">Not now</button><button class="game-button primary" data-action="connect-selected" ${connecting ? 'disabled' : ''}>Connect</button></div></section>`;
function activityLabel() {
  const t = state.telemetry;
  if (t.waiting) return 'Waiting for your input';
  if (t.running) return `${t.running} ${t.running === 1 ? 'chat' : 'chats'} working`;
  if (t.activity === 'unknown') return 'Checking the connection';
  return 'Resting at camp';
}

// Until the silhouettes resolve, the old name stays on screen: no spoilers mid-evolution.
const shownName = () => (reactionKind === 'evolve' && previousForm && performance.now() < reactionStarted + 2400 ? previousForm : state.active.species).name;
function renderBuddy() {
  const t = state.telemetry, ready = t.attention.filter(e => e.kind === 'completed').length;
  const asks = t.attention.filter(e => e.kind === 'input_needed');
  const questions = asks.length > 0;
  const askLine = new Set(asks.map(e => e.app || 'codex')).size > 1 ? lore.bothApps() : asks[0] ? eventText(asks[0]) : '';
  const busy = ['codex', 'claude'].filter(app => t.apps?.[app]?.running);
  const workLine = busy.length === 2 ? 'Codex and Claude are working' : busy.length ? `${appName(busy[0])} is working` : 'Working';
  const low = allowance.warning(t.apps);
  const updates = t.attention.filter(e => ['completed', 'input_needed', 'stopped', 'limit_reached', 'low_allowance'].includes(e.kind)).length;
  const urgent = t.attention.find(e => e.kind === 'limit_reached');
  const fighting = state.battle && !state.battle.over ? `Battling a wild ${state.battle.wild.name}!` : '';
  const bubble = state.settings.quiet ? '' : questions ? askLine : urgent ? eventText(urgent) : fighting || transient || (t.running ? workLine : ready ? 'Ready to review' : '');
  const counts = [t.running ? `${t.running} working` : '', updates ? `${updates} update${updates === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
  return `<div class="buddy-wrap"><button data-hit data-action="updates" class="bubble ${bubble ? '' : 'empty'}" aria-live="polite">${escape(bubble)}</button>
    <button class="buddy-hit" data-hit data-action="show" aria-label="Open Pocodex">${scenery.svg(state.background)}<span class="ground"></span>${state.active ? liveSprite(state.active.species) : egg()}${reactionArt()}</button>
    <button class="buddy-caption" data-hit data-action="${updates ? 'updates' : 'show'}">${state.active ? `${escape(shownName())} · Lv. ${state.active.level}` : state.egg?.choices.length ? 'Your egg hatched!' : 'Egg'}<small>${t.waiting ? 'Needs you' : urgent ? 'Allowance blocked' : low || counts || (t.activity === 'unknown' ? 'Checking' : 'Resting')}</small></button></div>`;
}
function header() {
  return `<header class="device-header"><span class="lens" aria-hidden="true"></span><span class="lights" aria-hidden="true"><i></i><i></i><i></i></span><strong>Pocodex</strong>${isPreview ? '<small>Test collection</small>' : ''}${soundButton()}</header>`;
}
function navigation() {
  return `<nav aria-label="Main navigation">${[['home', 'Buddy', 'paw-print'], ['dex', 'Pokédex', 'book-open'], ['usage', 'Usage', 'chart-bar'], ['settings', 'Settings', 'gear-six']].map(([key, label, glyph]) => `<button data-page="${key}" aria-current="${page === key || (page === 'card' && key === 'dex') ? 'page' : 'false'}">${icon(glyph)}${label}</button>`).join('')}</nav>`;
}
function attention() {
  const priority = { input_needed: 0, limit_reached: 1, stopped: 2, completed: 3, low_allowance: 4 };
  return state.telemetry.attention.slice().sort((a, b) => (priority[a.kind] ?? 5) - (priority[b.kind] ?? 5) || b.at - a.at).map(e => `<article class="attention-card"><div><strong>${escape(eventText(e))}</strong><small>${appTag(e.app)} ${escape(e.project || (e.app ? appName(e.app) : 'Pocodex'))} · ${new Date(e.at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${e.thread ? ` · ${escape(e.thread.slice(0, 8))}` : ''}</small>${e.preview ? messagePreview(e.preview) : ''}${(e.questions || []).map(q => `<div class="question-preview"><p>${escape(q.text)}</p>${q.options.length ? `<ul>${q.options.map(o => `<li>${escape(o)}</li>`).join('')}</ul>` : ''}</div>`).join('')}${e.kind === 'input_needed' ? `<small>${e.reason === 'permission' ? `Allow or deny it in ${appName(e.app)} Code.` : `Answer in ${appName(e.app)}.`}${e.asynchronous ? ' Work can continue meanwhile.' : ''}</small>` : ''}${!state.settings.message_previews && ['completed', 'input_needed'].includes(e.kind) ? '<small>Message previews are off in Settings.</small>' : ''}${state.settings.message_previews && e.kind === 'completed' && !e.preview ? `<small>No answer excerpt in this record. Read it in ${appName(e.app)}.</small>` : ''}</div>${e.kind === 'break_reminder' && e.battle && state.battles_left ? '<button class="game-button small" data-action="battle">Battle!</button>' : ''}<button data-ack="${e.id}" aria-label="Dismiss ${escape(eventText(e))}">${icon('check')}</button></article>`).join('');
}
function updatesPage() {
  const events = state.telemetry.attention.filter(e => ['completed', 'input_needed', 'stopped', 'limit_reached', 'low_allowance'].includes(e.kind));
  const event = events.find(e => e.kind === 'input_needed') || events.at(-1);
  if (!event) return '';
  const permission = event.kind === 'input_needed' && event.reason === 'permission';
  const title = event.kind === 'completed' ? 'New answer' : permission ? 'Permission needed' : event.kind === 'input_needed' ? 'Your move, Trainer' : eventText(event);
  return `<div class="updates-shell"><header class="updates-header"><div><strong>${escape(title)}</strong><small>${appTag(event.app)} ${escape(event.project || appName(event.app))}</small></div><button class="icon-button" data-action="hide-updates" aria-label="Close updates">${icon('x')}</button></header><main aria-live="polite">${event.preview ? messagePreview(event.preview) : ''}${(event.questions || []).map(q => `<div class="question-preview"><p>${escape(q.text)}</p>${q.options.length ? `<div class="question-options">${q.options.map(o => `<span>${escape(o)}</span>`).join('')}</div>` : ''}</div>`).join('')}${permission ? `<p>${appName(event.app)} Code is waiting for you to allow or deny an action.</p>` : event.kind === 'input_needed' ? `<small>Answer in ${appName(event.app)}.${event.asynchronous ? ' Work continues.' : ''}</small>` : ''}${!state.settings.message_previews ? '<small>Message previews are off in Settings.</small>' : ''}${state.settings.message_previews && event.kind === 'completed' && !event.preview ? `<p>${appName(event.app)} finished. This record has no answer text, so read it in ${appName(event.app)}.</p>` : ''}</main></div>`;
}
function homePage() {
  if (!state.active && state.egg?.choices.length) return hatchPage();
  const active = state.active;
  return `<section>${state.settings.connections_reviewed ? allowanceStrip() : connectCard()}${attention()}<div class="section-top"><p class="eyebrow">${active ? 'Walking with you' : 'Egg watch'}</p><span class="badge">${active ? `No. ${String(active.species.species_id).padStart(3, '0')}` : 'Egg'}</span></div>
    <div class="field">${active ? liveSprite(active.species, 'hero-sprite') : egg()}${reactionArt()}<span class="field-label${transient ? ' dialogue' : ''}">${escape(transient || activityLabel())}</span></div>
    <div class="name-row"><h1>${active ? escape(shownName()) : 'Your egg'}</h1>${active ? `<span class="level">Lv. ${active.level}</span>` : ''}</div>
    ${progress(active ? active.progress : (state.egg?.seconds || 0) / 120, active ? 'Next level' : 'Egg incubation')}
    <p class="fine">${active ? active.level === 100 ? 'Level 100. Stay together as long as you like.' : `${minutes(active.active_seconds)} together` : 'Two active minutes to hatch'}</p>
    ${active ? `${treatControls(active)}${wildGrass()}${evolutionSection(active)}` : `<p class="egg-check">${escape(lore.eggCheck(state.egg?.seconds || 0))}</p><p class="fine">${Math.max(0, Math.ceil(120 - (state.egg?.seconds || 0)))} active seconds left. Waiting and idle time do not count.</p>`}
    <div class="mini-stats"><div><strong>${minutes(state.today_seconds)}</strong><span>Active today</span></div><div><strong>${number(state.telemetry.tokens)}</strong><span>Tokens today</span></div></div></section>`;
}
function hatchPage() {
  return `<section class="hatch-page"><h1>Your egg hatched</h1><p>Choose a companion, or meet another three.</p><div class="hatch-grid">${state.egg.choices.map(p => `<article><div class="choice-sprite">${sprite(p)}</div><h2>${escape(p.name)}</h2><p class="fine">${escape((p.types || []).join(' / '))}</p><button class="primary" data-adopt="${p.id}">Keep ${escape(p.name)}</button><details><summary>Evolution path</summary><p>${escape(p.evolutions.map(e => `${state.roster.find(s => s.id === e.to)?.name || 'Evolution'} · ${e.requirement}`).join(' / ') || 'No evolution. Grows to level 100.')}</p></details></article>`).join('')}</div><button class="full" data-action="refresh_choices">Show another three</button><p class="fine">Only the one you keep enters your Pokédex. No penalty for choosing again.</p></section>`;
}
function evolutionSection(active) {
  if (!active.evolutions.length) return '<p class="fine">This form has no further evolution.</p>';
  return `<div class="evolution"><p class="eyebrow">Evolution</p>${active.evolutions.map(e => `<div class="evolution-row">${sprite(e.species)}<div><strong>${escape(e.species.name)}</strong><small>${escape(e.requirement)}</small></div><button data-evolution="${e.to}" ${e.eligible ? '' : 'disabled'}>${e.eligible ? 'Evolve' : 'Growing'}</button></div>`).join('')}</div>`;
}
function dexPage() {
  const unlocked = new Map(state.pokedex.map(entry => [entry.species.id, entry]));
  // Owned: hatched, evolved or caught. Seen: met in battle. Everything else stays a silhouette.
  const seen = new Set(state.seen || []);
  const known = p => unlocked.has(p.id) || seen.has(p.id);
  const roster = state.roster.filter(p => (dexScope === 'all' || unlocked.has(p.id)) && ((known(p) && p.name.toLowerCase().includes(filter.toLowerCase())) || String(p.species_id).padStart(3, '0').includes(filter)));
  const selected = unlocked.get(selectedDex);
  const current = selected?.unlocks.find(u => u.current);
  return `<section class="pokedex"><h1 class="sr-only">Your Pokédex</h1><button class="game-button card-link" data-page="card">Trainer Card <small>${state.badges.filter(b => b.earned).length} of 8 badges</small></button>${selected ? dexDetail(selected) : '<div class="name-row"><h2>Pokédex</h2></div>'}
    <div class="dex-toolbar"><div class="dex-scope" role="group" aria-label="Pokédex filter"><button data-scope="unlocked" aria-pressed="${dexScope === 'unlocked'}" aria-label="Owned"><span>${state.pokedex.length} owned</span></button><button data-scope="all" aria-pressed="${dexScope === 'all'}" aria-label="All Pokémon">All ${state.roster.length}</button></div><label class="search-label"><span class="sr-only">Find a Pokémon</span>${icon('magnifying-glass')}<input id="dex-search" type="search" value="${escape(filter)}" placeholder="Name or number" autocomplete="off"></label></div>
    ${!roster.length ? `<div class="search-empty"><strong>${filter ? 'No Pokémon match' : 'No Pokémon owned yet'}</strong><p class="fine">${filter ? 'Try another name or number, or browse all Pokémon.' : 'Hatch your first egg to start your collection.'}</p></div>` : ''}
    <p class="fine dex-count">${state.pokedex.length} owned · ${new Set([...seen, ...unlocked.keys()]).size} seen of ${state.roster.length}</p><div class="dex-grid">${roster.map(p => { const entry = unlocked.get(p.id), met = seen.has(p.id); return `<button class="dex-card ${entry ? 'unlocked' : met ? 'seen' : 'locked'}" data-dex="${p.id}" aria-pressed="${selectedDex === p.id}" aria-label="${entry ? `${escape(p.name)}, level ${entry.best_level}` : met ? `${escape(p.name)}, seen` : 'Unknown Pokémon, not seen yet'}"><span class="dex-tile"><span class="dex-number">#${String(p.species_id).padStart(3, '0')}</span>${sprite(p)}</span><strong>${entry || met ? escape(p.name) : '???'}</strong><small>${entry ? `Lv. ${entry.best_level}` : met ? 'Seen' : 'Not seen yet'}</small>${entry ? `<time>${shortDate(entry.first_unlocked)}</time>` : ''}</button>`; }).join('')}</div>
    ${current ? `<button class="primary full take-along" data-switch="${current.individual_id}">${state.active_id === current.individual_id ? 'With you · open buddy' : 'Take along'}</button>` : ''}
    <h2>Your companions</h2>${state.collection.length ? state.collection.map(p => `<div class="collection-row">${sprite(p.species)}<div><strong>${escape(p.species.name)}</strong><small>Lv. ${p.level} · ${date(p.adopted_at)}</small></div><button data-switch="${p.id}">${p.id === state.active_id ? 'Active' : 'Take along'}</button></div>`).join('') : '<p class="fine">Your first companion will appear after hatching.</p>'}
    <button class="full" data-action="new_egg">${state.egg ? 'Return to egg' : 'Start a new egg'}</button><h2>Special encounters</h2>${state.encounters.map(e => `<div class="collection-row"><div><strong>${escape(e.species.name)}</strong><small>${e.families_needed} distinct families raised to level 100</small></div><button data-encounter="${e.species.id}" ${e.available ? '' : 'disabled'}>${e.adopted ? 'Met' : e.available ? 'Meet' : 'Locked'}</button></div>`).join('')}</section>`;
}
function togetherLine(individual) {
  const parts = Object.entries(individual.active_by_app || {}).filter(([, seconds]) => seconds >= 60)
    .map(([app, seconds]) => `${minutes(seconds)} with ${appName(app)}`);
  return parts.length ? parts.join(' · ') : `${minutes(individual.active_seconds)} active together`;
}
function dexDetail(entry) {
  const individual = state.collection.find(p => p.id === entry.unlocks[0].individual_id);
  const trail = (individual?.unlocks || []).map(u => ({ species: state.roster.find(p => p.id === u.species_id), label: `Lv. ${u.species_id === individual.species_id ? individual.level : u.level}`, locked: false }));
  for (const edge of individual?.evolutions || []) trail.push({ species: edge.species, label: edge.requirement, locked: !state.pokedex.some(p => p.species.id === edge.to) });
  return `<article class="dex-detail"><button class="detail-close icon-button" data-action="close-dex" aria-label="Close Pokémon details">${icon('x')}</button><div class="specimen-top"><div class="specimen-name"><span class="specimen-number">No. ${String(entry.species.species_id).padStart(3, '0')}</span><h2>${escape(entry.species.name)}</h2><p class="detail-level" aria-label="Highest level ${entry.best_level}">Lv. ${entry.best_level}</p><div class="types">${(entry.species.types || []).map(type => `<span data-type="${escape(type)}">${escape(type)}</span>`).join('')}</div></div><div class="specimen-sprite">${sprite(entry.species)}</div><div class="specimen-date"><p class="unlock-date"><span>Owned since</span><time title="${escape(date(entry.first_unlocked))}">${shortDate(entry.first_unlocked)}</time></p><p class="fine">${individual ? togetherLine(individual) : ''}</p>${entry.unlocks.some(u => u.current) ? '' : '<span class="fine">Earlier evolution form</span>'}</div></div><div class="evolution-trail" aria-label="Evolution line">${trail.map(p => `<div class="trail-form ${p.locked ? 'locked' : ''} ${p.species.id === entry.species.id ? 'selected' : ''}">${sprite(p.species)}<strong>${escape(p.species.name)}</strong><small>${escape(p.label)}</small></div>`).join('')}</div><details class="dex-history"><summary>Unlock history · ${entry.unlocks.length} ${entry.unlocks.length === 1 ? 'entry' : 'entries'}</summary>${entry.unlocks.map(u => `<div class="history-row"><span>${u.reason === 'evolution' ? 'Evolved' : u.reason === 'encounter' ? 'Met' : u.reason === 'caught' ? 'Caught' : 'Hatched'} · ${date(u.at)}<small>${u.current ? 'Current form' : 'Earlier form'} · Lv. ${u.level}</small></span>${u.current && state.active_id !== u.individual_id ? `<button data-switch="${u.individual_id}">Take along</button>` : ''}</div>`).join('')}</details></article>`;
}
function usagePage() {
  const t = state.telemetry;
  const block = app => {
    const info = t.apps?.[app];
    if (!info?.connected) return `<article class="usage-app" data-app="${app}"><h2>${appTag(app)}</h2><p class="fine">Not connected. Connect it in Settings to track it here.</p></article>`;
    return `<article class="usage-app" data-app="${app}"><h2>${appTag(app)}<span class="app-status" data-activity="${escape(info.activity)}">${appActivity[info.activity] || 'Resting'}</span></h2><dl class="token-row"><div><dt>Input</dt><dd>${number(info.input)}</dd></div><div><dt>Output</dt><dd>${number(info.output)}</dd></div><div><dt>Cached</dt><dd>${number(info.cached)}</dd></div></dl></article>`;
  };
  return `<section><h1>Usage today</h1>${allowanceStrip()}<div class="mini-stats"><div><strong>${minutes(state.today_seconds)}</strong><span>Active today</span></div><div><strong>${number(t.tokens)}</strong><span>Tokens today</span></div></div>${block('codex')}${block('claude')}<p class="fine">Cached tokens are part of input, not an extra charge. Tokens are not your plan's allowance.</p><h2>Recent activity</h2>${attention() || '<p class="fine">New answers and questions from either app appear here.</p>'}<h2>Recorded responses</h2>${t.usage.slice(-15).reverse().map(u => `<div class="usage-row"><div><strong>${appTag(u.app)} ${escape(u.project || 'Local project')}</strong><small>${escape(u.model)} · ${new Date(u.at * 1000).toLocaleTimeString()}</small></div><span>${number(u.total)} tokens</span></div>`).join('') || '<p class="fine">No responses recorded since Pocodex started.</p>'}<p class="fine">${escape(t.coverage)}. Active time is observed, not a productivity score.</p></section>`;
}
function desktopSettings() {
  return `<h2>Desktop</h2><label class="setting-row" for="startup-codex">Open when the Codex app starts<input id="startup-codex" type="checkbox" ${startupState?.enabled ? 'checked' : ''} ${!startupState || startupBusy ? 'disabled' : ''}></label>
    <p class="fine">A small watcher checks every two seconds whether the Codex desktop app is running. Your Windows user only, no admin rights. Quit completely stops it until you next sign in.</p>
    <label class="setting-row" for="setting-close_exits">Close button quits Pocodex completely<input id="setting-close_exits" type="checkbox" data-setting="close_exits" ${state.settings.close_exits ? 'checked' : ''}></label>
    <p class="fine">Back to work only closes this window. Quit completely stops the buddy, monitoring and startup watcher.</p>
    <h2>Pokégear alerts</h2><p class="fine">New answers and questions appear above your buddy without taking focus. Answers clear after 20 seconds, questions once you reply. Quiet mode silences them.</p><p class="fine">Optional message previews show private text on your desktop. Excerpts stay in memory and clear when switched off. Pocodex never sends replies or approves actions.</p>
    <h2>Sprite scenery</h2><div class="scene-preview">${scenery.svg(state.background)}${state.active ? sprite(state.active.species) : egg()}</div>
    <label class="setting-row" for="background-choice">Sprite scenery<select id="background-choice"><option value="none" ${state.settings.background === 'none' ? 'selected' : ''}>None</option>${scenery.choices.map(s => `<option value="${s.id}" ${state.settings.background === s.id ? 'selected' : ''}>${s.label}</option>`).join('')}<option value="random" ${state.settings.background === 'random' ? 'selected' : ''}>Random</option></select></label>
    ${state.settings.background === 'random' ? '<button data-action="shuffle-background">Shuffle scenery</button>' : ''}<p class="fine">Random picks a scene each launch; Shuffle picks another now.</p><h2>Sound and reactions</h2>`;
}
// The opt-in usage check: the Claude app keeps its allowance to itself, Claude Code's /usage screen does not.
function usageCheck(claude) {
  const check = claude.usage_check || {}, on = state.settings.claude_usage_check;
  const status = !claude.enabled ? 'Connect Claude Code first' : !on ? 'Off' : check.problem ? check.problem
    : check.at ? `Checked ${Math.max(1, Math.round((state.now - check.at) / 60))} min ago` : 'Checking now';
  return `<div class="setting-row connection"><span><label for="setting-claude_usage_check">Check Claude's usage with Claude Code</label><small id="usage-check-status">${escape(status)}</small></span><input id="setting-claude_usage_check" type="checkbox" data-setting="claude_usage_check" aria-describedby="usage-check-status" ${on ? 'checked' : ''} ${claude.enabled ? '' : 'disabled'}></div>
    <p class="fine">For the Claude app, which never shares its allowance. Every 10 minutes Pocodex runs your Claude Code hidden, reads its /usage screen and closes it. It spends no tokens. Needs Claude Code installed on Windows and signed in.</p>`;
}
function connectionSettings() {
  const c = state.connections || {};
  const seen = at => at ? `last event ${Math.max(1, Math.round((state.now - at) / 60))} min ago` : 'waiting for the first reply';
  const line = app => {
    const link = c[app] || {}, info = state.telemetry.apps?.[app];
    if (link.enabled) return `Connected · ${seen(info?.last_event)}`;
    return link.found ? 'Not connected' : 'Not found on this PC';
  };
  const claude = c.claude || {};
  const problem = claude.error === 'unreadable' ? `<div class="settings-problem" role="status"><p>Pocodex could not read ${escape(claude.path)}\\settings.json, so it left the file unchanged. To connect by hand, merge this into it:</p><pre class="snippet">${escape(claude.snippet || '')}</pre></div>` : '';
  const statusLine = claude.enabled && !claude.status_line ? '<p class="fine">Hooks are on. The status line could not be added, so Claude\'s allowance will not show.</p>' : '';
  return `<h2>Connections</h2>
    <div class="setting-row connection"><span><label for="watch-codex">Watch Codex</label><small id="watch-codex-status">${line('codex')}</small></span><input id="watch-codex" type="checkbox" data-connect-toggle="codex" aria-describedby="watch-codex-status" ${c.codex?.enabled ? 'checked' : ''} ${c.codex?.found || c.codex?.enabled ? '' : 'disabled'}></div>
    <div class="setting-row connection"><span><label for="watch-claude">Watch Claude Code</label><small id="watch-claude-status">${line('claude')}</small></span><input id="watch-claude" type="checkbox" data-connect-toggle="claude" aria-describedby="watch-claude-status" ${claude.enabled ? 'checked' : ''} ${claude.found || claude.enabled ? '' : 'disabled'}></div>
    <p class="fine">Claude Code: Pocodex adds its own hooks and a status line to ${escape((claude.path || '~/.claude') + '\\settings.json')} and removes exactly those when you untick it or uninstall. Claude shares its live allowance only with terminal sessions; in the desktop app, a limit shows here once you hit it, until it resets.</p>${statusLine}${problem}
    ${usageCheck(claude)}
    <button class="game-button small" data-action="detect">Check again</button>`;
}
function settingsPage() {
  const options = [['auto_updates', 'Show updates automatically'], ['message_previews', 'Show message previews'], ['sound', 'Play Pokémon cries'], ['quiet', 'Quiet mode'], ['reduced_motion', 'Reduce motion'], ['always_on_top', 'Keep buddy on top'], ['completion_sound', 'Response-ready sounds'], ['attention_sound', 'Attention and allowance sounds'], ['milestone_sound', 'Hatch, evolution and treat sounds'], ['break_reminders', 'Gentle break reminders']];
  return `<section><h1>Settings</h1>${connectionSettings()}${desktopSettings()}${options.map(([key, label]) => `<label class="setting-row" for="setting-${key}">${label}<input id="setting-${key}" type="checkbox" data-setting="${key}" ${state.settings[key] ? 'checked' : ''}></label>`).join('')}<label class="setting-row" for="volume">Volume<input id="volume" type="range" min="0" max="1" step="0.05" value="${state.settings.volume}"></label><button data-action="preview-sound">Preview cry</button><h2>Codex folders</h2>${state.telemetry.sources.map(s => `<div class="source-card"><strong>${escape(s.status)}</strong><code>${escape(s.path)}</code></div>`).join('')}<button data-action="add-source">Add Windows / WSL Codex folder</button><p class="fine">Choose only a Codex home you want to monitor. WSL must already be running; Pocodex does not start it or request elevated access.</p><h2>What Pocodex can see</h2><p class="fine">Answers finishing, token counts and questions from both apps. Claude Code's permission prompts too; Codex's native approval dialogs are not observable.</p><p class="fine">Allowance is shown only from observed local records. After 120 seconds without activity evidence, a running chat becomes unknown and stops earning XP.</p><h2>Your collection</h2><button data-action="export">Export collection and unlock history</button><p class="fine">Your collection is saved locally. Export includes adoption and evolution dates. Nothing is uploaded.</p><button data-action="replay-intro">Replay Professor Oak's intro</button><h2>About Pocodex</h2><p class="fine">Pocodex is an unofficial, non-commercial fan project. Pokémon characters, sprites and cries belong to their owners. Not affiliated with Nintendo, The Pokémon Company, OpenAI, Anthropic or PokeTokenBar.</p><button data-action="quit">Quit Pocodex</button></section>`;
}
function evolutionDialog() {
  const edge = state.active?.evolutions.find(e => e.to === selectedEvolution);
  if (!edge) return '';
  return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="evolve-title"><p class="eyebrow">WHAT? ${escape(state.active.species.name.toUpperCase())} IS EVOLVING!</p><h2 id="evolve-title">Evolve into ${escape(edge.species.name)}?</h2><div class="evolve-pair">${sprite(state.active.species)}<span>→</span>${sprite(edge.species)}</div><p>${escape(edge.requirement)}</p><p class="fine">Same partner. New form. Level and history stay with you.</p><div class="actions"><button data-action="later">Later</button><button class="primary" data-confirm-evolution="${edge.to}">Evolve</button></div></section></div>`;
}
function render() {
  if (!state) return;
  document.body.dataset.activity = state.telemetry.activity;
  document.body.dataset.reaction = reactionKind;
  document.body.classList.toggle('reduced-motion', state.settings.reduced_motion);
  const currentFocus = document.activeElement;
  if (transientId && !state.telemetry.attention.some(e => e.id === transientId)) { transient = ''; transientId = null; reactionKind = ''; document.body.classList.remove('celebrating'); }
  const focusAttribute = ['id', 'data-connect', 'data-action', 'data-page', 'data-scope', 'data-evolution', 'data-confirm-evolution', 'data-switch', 'data-dex', 'data-ack', 'data-adopt', 'data-intro'].find(key => currentFocus?.hasAttribute(key));
  const focused = focusAttribute ? `[${focusAttribute}="${CSS.escape(currentFocus.getAttribute(focusAttribute))}"]` : null;
  const selection = document.activeElement instanceof HTMLInputElement && document.activeElement.type === 'search' ? document.activeElement.selectionStart : null;
  const html = isBuddy ? renderBuddy() : isUpdates ? updatesPage() : intro.active(state) ? `<div class="home-content intro-mode">${header()}<main>${intro.render()}</main></div>` : `<div class="home-content" ${selectedEvolution ? 'inert' : ''}>${header()}<main>${({ home: homePage, dex: dexPage, usage: usagePage, settings: settingsPage, card: trainerCard.render })[page]()}</main>${navigation()}<footer><span class="status-dot"></span><span class="footer-status">${escape(activityLabel())}</span><button data-action="hide">Back to work</button><button data-action="quit" aria-label="Quit completely">Quit</button></footer></div>${evolutionDialog()}`;
  if (lastMarkup !== html) {
    lastMarkup = html;
    appRoot.innerHTML = html;
    if (focused) { const element = appRoot.querySelector(focused); element?.focus({ preventScroll: true }); if (selection !== null && element) element.setSelectionRange(selection, selection); }
  }
  actionMotion.sync(document.querySelector('[data-sprite-motion]'), state.active?.species, state.telemetry.activity, reactionKind, state.settings.reduced_motion, previousForm, reactionStarted);
  paintStillSprites();
  if (!isBuddy && !isUpdates) { battleScene.sync(); intro.sync(); }
  // Poll-driven DOM refreshes must not restart an in-flight reaction.
  for (const animation of document.querySelector('[data-effect]')?.getAnimations({ subtree: true }) || []) {
    animation.currentTime = performance.now() - reactionStarted;
  }
}
document.addEventListener('sprite-error', event => error(event.detail));

appRoot.addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button && event.target.closest('[data-intro-box]')) { await intro.act('next'); return; }
  if (!button || button.disabled) return;
  if (button.dataset.intro) { await intro.act(button.dataset.intro); return; }
  if (button.dataset.page) { page = button.dataset.page; selectedDex = page === 'dex' ? state.active?.species.id ?? null : null; render(); window.scrollTo(0, 0); return; }
  if (button.dataset.scope) { dexScope = button.dataset.scope; selectedDex = null; render(); return; }
  if (button.dataset.adopt) { await command('adopt', { species_id: Number(button.dataset.adopt) }); return; }
  if (button.dataset.switch) { await command('switch', { id: button.dataset.switch }); page = 'home'; render(); return; }
  if (button.dataset.dex) { selectedDex = Number(button.dataset.dex); render(); document.querySelector('.dex-detail')?.scrollIntoView({ behavior: 'instant', block: 'nearest' }); return; }
  if (button.dataset.evolution) { selectedEvolution = Number(button.dataset.evolution); render(); document.querySelector('[data-action="later"]')?.focus(); return; }
  if (button.dataset.confirmEvolution) { await command('evolve', { species_id: Number(button.dataset.confirmEvolution) }); selectedEvolution = null; render(); return; }
  if (button.dataset.encounter) { await command('encounter', { species_id: Number(button.dataset.encounter) }); page = 'home'; render(); return; }
  if (button.dataset.ack) { await command('acknowledge', { id: button.dataset.ack }); return; }
  if (button.dataset.cardAction) { if (await trainerCard.action(button.dataset.cardAction, document.querySelector('.card-note'))) render(); return; }
  if (button.dataset.connect) { await command('connect', { app: button.dataset.connect, enabled: true }); return; }
  const action = button.dataset.action;
  if (action === 'mute') { audio?.pause(); await command('settings', { sound: !state.settings.sound }); }
  else if (action === 'connect-selected') {
    connecting = true; render();
    try { if (await connectChosen()) { connectChoice = {}; await command('settings', { connections_reviewed: true }); } }
    finally { connecting = false; render(); }
  }
  else if (action === 'connect-later') { connectChoice = {}; await command('settings', { connections_reviewed: true }); }
  else if (action === 'detect') await command('detect');
  else if (action === 'battle') await command('battle_start');
  else if (action === 'show') api.showHome();
  else if (action === 'updates') api.showUpdates();
  else if (action === 'hide-updates') api.hideUpdates();
  else if (action === 'hide') api.hideHome();
  else if (action === 'quit') api.quit();
  else if (action === 'shuffle-background') await command('shuffle_background');
  else if (action === 'new_egg') { await command(action); page = 'home'; render(); }
  else if (action === 'refresh_choices') await command(action);
  else if (action === 'pet' || action === 'berry') await command(action);
  else if (action === 'preview-sound') { if (!state.active) error('Hatch a companion first to preview its cry.'); else playCry('preview'); }
  else if (action === 'add-source') api.addSource().catch(e => error(e.message));
  else if (action === 'export') api.exportSave().catch(e => error(e.message));
  else if (action === 'replay-intro') { page = 'home'; intro.replay(); window.scrollTo(0, 0); }
  else if (action === 'close-dex') { selectedDex = null; render(); }
  else if (action === 'later') closeEvolution();
});
appRoot.addEventListener('change', async event => {
  if (event.target.id === 'startup-codex') {
    const enabled = event.target.checked;
    startupBusy = true; render();
    try { startupState = await api.startup(enabled); errorBox.hidden = true; }
    catch (failure) { error(failure.message); }
    finally { startupBusy = false; render(); }
  }
  if (event.target.dataset.choice) { connectChoice[event.target.dataset.choice] = event.target.checked; render(); }
  if (event.target.dataset.connectToggle) command('connect', { app: event.target.dataset.connectToggle, enabled: event.target.checked });
  if (event.target.id === 'background-choice') command('settings', { background: event.target.value });
  if (event.target.dataset.setting) command('settings', { [event.target.dataset.setting]: event.target.checked });
  if (event.target.id === 'volume') command('settings', { volume: Number(event.target.value) });
});
appRoot.addEventListener('submit', async event => {
  if (event.target.matches('[data-intro-name]')) { event.preventDefault(); await intro.act('name', event.target.querySelector('input').value); return; }
  if (!event.target.matches('[data-card-name]')) return;
  event.preventDefault();
  await command('trainer', { name: event.target.querySelector('input').value });
});
appRoot.addEventListener('input', event => { if (event.target.id === 'dex-search') { filter = event.target.value; selectedDex = null; render(); } });
function closeEvolution() {
  const target = selectedEvolution;
  selectedEvolution = null; render();
  document.querySelector(`[data-evolution="${target}"]`)?.focus({ preventScroll: true });
}
document.addEventListener('keydown', event => {
  if (!isBuddy && !isUpdates && intro.active(state)) intro.key(event);
  if (event.key === 'Escape' && battleScene.isOpen()) return;
  if (event.key === 'Escape') { if (isUpdates) api.hideUpdates(); else if (selectedEvolution) closeEvolution(); else api.hideHome(); }
  if (event.key === 'Tab' && selectedEvolution) {
    const buttons = [...document.querySelectorAll('[role="dialog"] button:not(:disabled)')];
    const index = buttons.indexOf(document.activeElement);
    event.preventDefault();
    buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
  }
});

if (isBuddy) {
  let drag;
  document.addEventListener('pointermove', event => {
    api.hitRegion(Boolean(event.target.closest('[data-hit]')) || Boolean(drag));
    if (drag && event.buttons) {
      const delta = { x: event.screenX - drag.x, y: event.screenY - drag.y };
      if (Math.abs(delta.x) + Math.abs(delta.y) > 2) { drag.moved = true; api.moveBuddy(delta); drag.x = event.screenX; drag.y = event.screenY; }
    }
  });
  document.addEventListener('pointerdown', event => { if (event.target.closest('.buddy-hit')) { drag = { x: event.screenX, y: event.screenY, moved: false }; event.target.setPointerCapture(event.pointerId); } });
  document.addEventListener('click', event => { if (drag?.moved) { event.stopImmediatePropagation(); event.preventDefault(); } drag = null; }, true);
  document.addEventListener('pointerleave', () => { if (!drag) api.hitRegion(false); });
}
api.onState(message => {
  const before = state;
  state = message.state;
  if (!state.settings.sound || state.settings.quiet) audio?.pause();
  if (!state.settings.sound || state.settings.quiet || !state.settings.milestone_sound) {
    evolutionAudio?.close(); evolutionAudio = null; clearTimeout(evolutionCryTimer);
  }
  if (state.settings.quiet) { clearTimeout(evolutionTextTimer); transient = ''; reactionKind = ''; document.body.classList.remove('celebrating'); }
  render();
  const change = (message.events || []).some(e => e.kind === 'evolve') ? null : lore.companionChange(before, state);
  if (change) react(change.text, change.kind);
  const priority = { limit_reached: 0, input_needed: 1, low_allowance: 2, badge: 3, completed: 4, stopped: 5, evolution_ready: 6, level_up: 7, break_reminder: 8 };
  const freshEvents = (message.events || []).filter(event => !seenEvents.has(event.id));
  for (const event of freshEvents) seenEvents.add(event.id);
  while (seenEvents.size > 256) seenEvents.delete(seenEvents.values().next().value);
  freshEvents.sort((a, b) => (priority[a.kind] ?? 9) - (priority[b.kind] ?? 9));
  if (freshEvents.length && !isUpdates) {
    const interaction = freshEvents.find(e => ['pet', 'berry', 'evolve'].includes(e.kind));
    const levelUp = freshEvents.find(e => e.kind === 'level_up');
    if (interaction?.kind === 'evolve' && interaction.previous_species && state.active) {
      previousForm = interaction.previous_species;
      const from = previousForm.name, to = state.active.species.name;
      react(lore.evolving(from), 'evolve', null, 4800);
      // The name is revealed with the new form, not before (sprite-layout.js evolution timeline).
      if (!state.settings.quiet) evolutionTextTimer = setTimeout(() => { transient = lore.evolved(from, to); render(); }, 2400);
    } else if (interaction?.kind === 'evolve') {
      react(`${state.active?.species.name || 'Your partner'} evolved!`, 'evolve');
    } else if (interaction) {
      const line = interaction.kind === 'pet' ? lore.petLine(state.active.species, state.treats.pets_left) : lore.berryLine;
      react(lore.treatReaction(line, levelUp), interaction.kind);
    } else {
      const first = freshEvents[0];
      // Only queued alerts keep their id; a level-up bubble must not vanish on the next poll.
      react(lore.arrival(first), first.kind, state.telemetry.attention.some(e => e.id === first.id) ? first.id : null);
    }
  }
});
api.onFault(message => { document.body.dataset.activity = 'unknown'; error(message); });
api.onNavigate(destination => {
  if (isBuddy || isUpdates || !['home', 'dex', 'usage', 'settings', 'card'].includes(destination)) return;
  page = destination;
  selectedDex = page === 'dex' ? state?.active?.species.id ?? null : null;
  selectedEvolution = null;
  render();
  window.scrollTo(0, 0);
  const heading = document.querySelector('h2');
  if (heading) { heading.tabIndex = -1; heading.focus(); }
});
intro.init({ state: () => state, render, escape, egg, sprite, connectRows, connectChosen, command });
api.snapshot().then(result => { if (result) { state = result; render(); } });
if (!isBuddy && !isUpdates) api.startup().then(result => { startupState = result; render(); }).catch(failure => error(failure.message));
