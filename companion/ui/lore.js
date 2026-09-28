/* Pokemon-flavoured lines. Deterministic, local, and the useful fact always survives the joke. */
const lore = (() => {
  const plural = (count, one, many) => count === 1 ? one : `${count} ${many}`;
  const apps = { codex: 'Codex', claude: 'Claude' };
  function eventLine(event) {
    switch (event.kind) {
      case 'completed': return 'Ready to review';
      case 'input_needed': return event.reason === 'permission' ? `Your move, Trainer! ${apps[event.app] || 'Codex'} needs permission` : 'Your move, Trainer! Need your input';
      case 'stopped': return `Work paused. ${apps[event.app] || 'Codex'} is catching its breath`;
      case 'limit_reached': return `Out of PP! ${apps[event.app] || 'Codex'} allowance used up`;
      case 'low_allowance': return `PP running low: ${event.remaining}% ${apps[event.app] || 'Codex'} allowance left`;
      case 'break_reminder': return 'Your team looks tired. Pokémon Center break? (50 min of work)';
      case 'level_up': return `${event.name} grew to Lv. ${event.level}!${event.berries ? ` Got ${plural(event.berries, 'an Oran Berry', 'Oran Berries')}!` : ''}`;
      case 'evolution_ready': return `What? ${event.name} is ready to evolve!`;
      case 'badge': return `You received the ${event.name}!`;
      default: return 'Something needs attention';
    }
  }
  // Reaction when a completion first lands; the bubble then settles on the plain eventLine.
  const arrival = event => event.kind === 'completed' ? "It's super effective! Ready to review" : eventLine(event);
  // Compares individuals, not species: two Pikachu are two different partners. Evolutions animate elsewhere.
  function companionChange(before, after) {
    if (!before) return null;
    const was = before.active, now = after.active;
    if (was && !now) return after.egg && !after.egg.choices?.length ? { text: 'A fresh Egg from the Day Care!', kind: 'egg' } : null;
    if (!now) return !before.egg?.choices?.length && after.egg?.choices?.length ? { text: 'Oh? The Egg is hatching!', kind: 'milestone' } : null;
    if (was?.id === now.id) return null;
    return { text: `${now.species.name}, I choose you!`, kind: 'milestone' };
  }
  const evolving = name => `What? ${name} is evolving!`;
  const evolved = (from, to) => `Congratulations! ${from} evolved into ${to}!`;
  const petFlavour = {
    fire: 'Its flame flickers happily', water: 'It splashes with joy', grass: 'It smells like a sunny meadow',
    electric: 'Its cheeks crackle with joy', psychic: 'It already knew you would do that', ghost: 'It giggled… from behind you',
    ice: 'It feels pleasantly chilly', rock: 'It seems a little less rocky', ground: 'It rolls in the dirt, delighted',
    dragon: 'It lets out a proud little roar', fighting: 'It flexes. You are not sure why', poison: 'It purrs. Mostly harmless',
    bug: 'Its antennae twitch happily', flying: 'It flutters around your cursor', steel: 'Clank! A happy clank',
    dark: 'It pretends not to enjoy it', fairy: 'It sparkles a little', normal: 'It nuzzles your hand',
  };
  const petOpeners = ['Critical scritch!', 'Friendship up!', 'Good pet!'];
  function petLine(species, count) {
    const flavour = petFlavour[species.types?.[0]] || `${species.name} looks happy`;
    return `${petOpeners[count % petOpeners.length]} ${flavour}. +1% XP`;
  }
  const berryLine = 'Munch! An Oran Berry. +20% XP';
  // A treat that levels up announces the level: both lines together overflow the buddy's bubble.
  const treatReaction = (line, levelUp) => levelUp ? eventLine(levelUp) : line;
  function eggCheck(seconds) {
    if (seconds < 30) return 'This Egg looks like it will take a while to hatch.';
    if (seconds < 75) return "It doesn't seem close to hatching yet.";
    if (seconds < 105) return 'It wiggles now and then. Hatching could be close!';
    return "Sounds are coming from inside! It'll hatch any moment!";
  }
  const bothApps = () => 'Your move, Trainer! Codex and Claude need you';
  // Battle text in the games' own phrasing. "wild" names the opposing side.
  const side = (who, name) => who === 'wild' ? `The wild ${name}` : name;
  const battle = {
    appear: name => `A wild ${name} appeared!`,
    send: name => `Go! ${name}!`,
    prompt: name => `What will ${name} do?`,
    used: (who, name, move) => `${side(who, name)} used ${move}!`,
    effect: (multiplier, target) => multiplier === 0 ? `It doesn't affect ${target}...` : multiplier > 1 ? "It's super effective!" : multiplier < 1 ? "It's not very effective..." : '',
    critical: 'A critical hit!',
    hits: count => `Hit ${count} times!`,
    missed: (who, name) => `${side(who, name)}'s attack missed!`,
    drained: (who, name) => `${side(who, name)} had its energy drained!`,
    recoil: (who, name) => `${side(who, name)} was damaged by the recoil!`,
    fainted: (who, name) => `${side(who, name)} fainted!`,
    threw: 'You threw a Poké Ball!',
    brokeFree: shakes => ['Oh no! The Pokémon broke free!', 'Aww! It appeared to be caught!', 'Aargh! Almost had it!', 'Gah! It was so close, too!'][shakes] || 'Oh no! The Pokémon broke free!',
    caught: name => `Gotcha! ${name} was caught!`,
    registered: name => `${name}'s data was added to the Pokédex.`,
    ran: 'Got away safely!',
    gained: (name, xp) => `${name} gained ${xp} EXP. Points!`,
    grew: (name, level) => `${name} grew to Lv. ${level}!`,
    ball: 'You found a Poké Ball!',
    lost: 'You hurried back to the Pokémon Center.',
  };
  return { treatReaction, eventLine, bothApps, battle, arrival, companionChange, evolving, evolved, petLine, berryLine, eggCheck };
})();
if (typeof module !== 'undefined') module.exports = lore;
