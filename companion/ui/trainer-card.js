/* The Trainer Card: a FireRed-style card that changes colour with your badges, flips to milestones,
   and can be copied or saved as the exact image on screen. */
const trainerCard = (() => {
  // Original badge emblems, drawn for Pocodex on a 16-unit grid.
  const EMBLEMS = {
    boulder: '<path fill="#8d8f93" d="M5 1h6l4 4v6l-4 4H5l-4-4V5z"/><path fill="#c3c5c9" d="M6 4h4l2 2v4l-2 2H6l-2-2V6z"/>',
    cascade: '<path fill="#3f7fd8" d="M8 1c3 4 5 7 5 9a5 5 0 0 1-10 0c0-2 2-5 5-9z"/><path fill="#a8d4ff" d="M6 9a2 2 0 0 0 2 3v-1a1 1 0 0 1-1-2z"/>',
    thunder: '<path fill="#f0a020" d="M8 0l2 5 5-1-3 4 3 4-5-1-2 5-2-5-5 1 3-4-3-4 5 1z"/><circle fill="#ffe07a" cx="8" cy="8" r="2.5"/>',
    rainbow: '<circle fill="#e8503a" cx="8" cy="4" r="3"/><circle fill="#f0c020" cx="12" cy="8" r="3"/><circle fill="#48b05a" cx="8" cy="12" r="3"/><circle fill="#4a86d8" cx="4" cy="8" r="3"/><circle fill="#fff4d8" cx="8" cy="8" r="2"/>',
    soul: '<path fill="#e8578f" d="M8 14L2 8a3.5 3.5 0 0 1 6-4 3.5 3.5 0 0 1 6 4z"/><path fill="#ffc0d8" d="M4 6a1.5 1.5 0 0 1 2-1v1H5v1H4z"/>',
    marsh: '<circle fill="#d8a020" cx="8" cy="8" r="7"/><circle fill="#fff0b0" cx="8" cy="8" r="4.5"/><circle fill="#d8a020" cx="8" cy="8" r="2.5"/>',
    volcano: '<path fill="#e04028" d="M8 1c1 3 5 5 5 9a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3 1-5 1-8z"/><path fill="#ffc050" d="M8 8c1 1 2 2 2 3a2 2 0 0 1-4 0c0-1 1-2 2-3z"/>',
    earth: '<path fill="#3f9a4a" d="M2 14C2 6 7 2 14 2c0 8-4 12-12 12z"/><path fill="#a8e090" d="M4 12l7-7-1 3-3 1z"/>',
  };
  const TIERS = [[8, 'gold'], [6, 'silver'], [4, 'bronze'], [2, 'green'], [0, 'blue']];
  let flipped = false;
  const pad = (value, size) => String(value).padStart(size, '0');
  const clock = seconds => `${Math.floor(seconds / 3600)}:${pad(Math.floor(seconds % 3600 / 60), 2)}`;
  const dateOf = seconds => new Date(seconds * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const emblem = (id, earned) => `<svg viewBox="0 0 16 16" class="emblem ${earned ? 'earned' : ''}" aria-hidden="true">${EMBLEMS[id]}</svg>`;

  function party() {
    const members = state.collection.slice().sort((a, b) => (b.id === state.active_id) - (a.id === state.active_id) || b.level - a.level).slice(0, 6);
    return members.map(p => `<span class="party-slot" title="${escape(p.species.name)}, Lv. ${p.level}">${sprite(p.species)}</span>`).join('') +
      Array.from({ length: 6 - members.length }, () => '<span class="party-slot empty"></span>').join('');
  }
  function milestones() {
    const unlocks = state.collection.flatMap(p => p.unlocks.map(u => ({ ...u, name: state.roster.find(r => r.id === u.species_id)?.name })));
    const first = reason => unlocks.filter(u => u.reason === reason).sort((a, b) => a.at - b.at)[0];
    const rows = [['Adventure began', dateOf(state.created)], ['First partner', first('hatched') && `${first('hatched').name} · ${dateOf(first('hatched').at)}`],
      ['First evolution', first('evolution') && `${first('evolution').name} · ${dateOf(first('evolution').at)}`],
      ['First catch', first('caught') && `${first('caught').name} · ${dateOf(first('caught').at)}`],
      ['Best streak', `${state.stats.best_streak} ${state.stats.best_streak === 1 ? 'day' : 'days'}`],
      ['Battles', `${state.stats.battles_won} won · ${state.stats.battles_lost} lost · ${state.stats.caught} caught`]];
    return rows.map(([label, value]) => `<div class="card-row"><dt>${label}</dt><dd>${escape(value || 'Not yet')}</dd></div>`).join('');
  }
  function render() {
    const badges = state.badges, earned = badges.filter(b => b.earned).length, tier = TIERS.find(([n]) => earned >= n)[1];
    const seconds = state.stats.seconds_by_app, total = Object.values(seconds).reduce((a, b) => a + b, 0);
    const seen = new Set([...(state.seen || []), ...state.pokedex.map(p => p.species.id)]).size;
    const partner = state.active;
    const split = total ? Math.round(100 * (seconds.codex || 0) / total) : 50;
    const front = `<div class="card-face front"><header class="card-head"><strong>Trainer Card</strong><span>ID No. ${pad(state.trainer.id, 5)}</span></header>
      <div class="card-body"><dl>
        <div class="card-row name"><dt>Name</dt><dd>${escape(state.trainer.name)}</dd></div>
        <div class="card-row"><dt>Pokédex</dt><dd>${state.pokedex.length} owned · ${seen} seen</dd></div>
        <div class="card-row"><dt>Time</dt><dd>${clock(total)}</dd></div>
        <div class="card-row"><dt>Answers</dt><dd>${state.stats.answers}</dd></div>
        <div class="card-row"><dt>Battles won</dt><dd>${state.stats.battles_won}</dd></div></dl>
        <div class="card-partner">${partner ? sprite(partner.species) : egg()}</div></div>
      <div class="card-badges" aria-label="${earned} of 8 badges">${badges.map(b => `<span class="badge-slot" title="${escape(b.name)}: ${escape(b.requirement)}${b.earned ? ` · earned ${dateOf(b.at)}` : ''}">${emblem(b.id, b.earned)}</span>`).join('')}</div>
      <div class="card-party" aria-label="Party">${party()}</div></div>`;
    const back = `<div class="card-face back"><header class="card-head"><strong>${escape(state.trainer.name)}'s record</strong><span>${earned} of 8 badges</span></header>
      <dl class="card-milestones">${milestones()}</dl>
      <div class="card-split" aria-label="Time with each app"><progress class="split-bar" max="100" value="${split}" aria-label="Share of time with Codex"></progress>
        <div class="split-legend"><span>Codex ${clock(seconds.codex || 0)}</span><span>Claude ${clock(seconds.claude || 0)}</span></div></div></div>`;
    return `<section class="card-page"><h1>Trainer Card</h1>
      <div class="trainer-card tier-${tier} ${flipped ? 'flipped' : ''}" data-card><div class="card-inner">${front}${back}</div></div>
      <div class="actions card-actions"><button class="game-button" data-card-action="flip">${flipped ? 'Show front' : 'Show back'}</button><button class="game-button" data-card-action="copy">Copy image</button><button class="game-button primary" data-card-action="save">Save PNG</button></div>
      <p class="fine card-note" aria-live="polite"></p>
      <h2>Gym Badges</h2><ul class="badge-list">${badges.map(b => `<li class="${b.earned ? 'earned' : ''}">${emblem(b.id, b.earned)}<span><strong>${escape(b.name)}</strong><small>${escape(b.requirement)}${b.earned ? ` · ${dateOf(b.at)}` : ''}</small></span></li>`).join('')}</ul>
      <h2>Trainer name</h2><form class="name-form" data-card-name><label class="sr-only" for="trainer-name">Trainer name</label><input id="trainer-name" maxlength="12" value="${escape(state.trainer.name)}" autocomplete="off"><button class="game-button">Save name</button></form></section>`;
  }
  async function action(kind, note) {
    if (kind === 'flip') { flipped = !flipped; return true; }
    const card = document.querySelector('[data-card]');
    card.scrollIntoView({ block: 'nearest' });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const box = card.getBoundingClientRect();
    try {
      const result = await window.pocodex.cardImage({ x: box.x, y: box.y, width: box.width, height: box.height }, kind);
      note.textContent = kind === 'copy' ? 'Copied. Paste it anywhere.' : result ? 'Saved.' : '';
    } catch (failure) { note.textContent = 'The card image could not be made. Try again.'; }
    return false;
  }
  return { render, action };
})();
