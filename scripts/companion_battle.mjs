/** Pin real base stats, catch rates and level-up damaging moves for every form. Refresh needs network; builds only copy. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readUrl, mapLimit } from './companion_catalog.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pinned = path.join(root, 'companion/data/battle.json');
const output = path.join(root, 'companion/assets/battle.json');
const api = 'https://pokeapi.co/api/v2';
// Newest games first: each form uses the most recent level-up learnset it has.
export const VERSION_GROUPS = ['scarlet-violet', 'legends-arceus', 'sword-shield', 'ultra-sun-ultra-moon', 'sun-moon',
  'omega-ruby-alpha-sapphire', 'x-y', 'black-2-white-2', 'black-white', 'heartgold-soulsilver', 'platinum',
  'diamond-pearl', 'emerald', 'firered-leafgreen', 'ruby-sapphire', 'crystal', 'gold-silver', 'yellow', 'red-blue'];
// Moves whose rules this one-on-one battle does not model honestly: two turns, recharge, conditions, self-KO, lock-in.
export const UNSUPPORTED = new Set(['solar-beam', 'solar-blade', 'sky-attack', 'razor-wind', 'skull-bash', 'dig', 'fly', 'bounce', 'dive',
  'phantom-force', 'shadow-force', 'meteor-beam', 'electro-shot', 'hyper-beam', 'giga-impact', 'blast-burn', 'frenzy-plant', 'hydro-cannon',
  'rock-wrecker', 'roar-of-time', 'eternabeam', 'prismatic-laser', 'snore', 'belch', 'last-resort', 'dream-eater', 'fake-out',
  'first-impression', 'focus-punch', 'self-destruct', 'explosion', 'misty-explosion', 'final-gambit', 'steel-beam', 'mind-blown',
  'future-sight', 'doom-desire', 'sucker-punch', 'synchronoise', 'burn-up', 'double-shock', 'uproar', 'outrage', 'thrash',
  'petal-dance', 'rollout', 'ice-ball', 'bide', 'counter', 'mirror-coat', 'metal-burst', 'raging-fury', 'sky-drop', 'freeze-shock', 'ice-burn']);
const STATS = ['hp', 'attack', 'defense', 'special-attack', 'special-defense', 'speed'];

/** Level-up entries for the newest version group the form appears in, sorted by level then API order. */
export function learnset(pokemon) {
  const byGroup = new Map();
  for (const entry of pokemon.moves) {
    for (const detail of entry.version_group_details) {
      if (detail.move_learn_method.name !== 'level-up') continue;
      const list = byGroup.get(detail.version_group.name) || [];
      list.push([entry.move.name, detail.level_learned_at]);
      byGroup.set(detail.version_group.name, list);
    }
  }
  const version = VERSION_GROUPS.find(group => byGroup.has(group));
  if (!version) return { version: null, moves: [] };
  const moves = byGroup.get(version).map((move, index) => ({ move, index })).sort((a, b) => a.move[1] - b.move[1] || a.index - b.index).map(({ move }) => move);
  return { version, moves };
}

/** Only moves the simplified battle can resolve: a fixed power and a physical or special class. */
export function damaging(move) {
  return Number.isInteger(move.power) && move.power > 0 && ['physical', 'special'].includes(move.damage_class?.name) && !UNSUPPORTED.has(move.name);
}

async function refresh() {
  const catalog = JSON.parse(await fs.readFile(path.join(root, 'companion/data/catalog.json')));
  const species = {}, moveNames = new Set();
  const forms = await mapLimit(catalog.species, async form => {
    const [pokemon, entry] = await Promise.all([readUrl(`${api}/pokemon/${form.slug}/`), readUrl(`${api}/pokemon-species/${form.species_id}/`)]);
    const { version, moves } = learnset(pokemon);
    moves.forEach(([name]) => moveNames.add(name));
    return { form, pokemon, entry, version, moves };
  });
  const details = new Map((await mapLimit([...moveNames, 'struggle'], name => readUrl(`${api}/move/${name}/`))).map(move => [move.name, move]));
  const moves = {};
  for (const [name, move] of [...details].sort(([a], [b]) => a.localeCompare(b))) {
    if (!damaging(move)) continue;
    moves[name] = { name: move.names.find(n => n.language.name === 'en')?.name || name, type: move.type.name, power: move.power,
      accuracy: move.accuracy, class: move.damage_class.name, priority: move.priority,
      // Multi-hit ranges, drain (+) or recoil (-) as a percentage of damage, and a raised critical-hit stage.
      ...(move.meta?.min_hits ? { hits: [move.meta.min_hits, move.meta.max_hits] } : {}),
      ...(move.meta?.drain ? { drain: move.meta.drain } : {}),
      ...(move.meta?.crit_rate ? { crit: move.meta.crit_rate } : {}) };
  }
  for (const { form, pokemon, entry, version, moves: list } of forms) {
    species[form.id] = {
      stats: STATS.map(stat => pokemon.stats.find(s => s.stat.name === stat).base_stat),
      capture: entry.capture_rate, experience: pokemon.base_experience || 50, version,
      learnset: list.filter(([name]) => moves[name]),
    };
  }
  const pack = { source: 'https://pokeapi.co', note: 'Base stats, catch rates and level-up damaging moves. Status moves and variable-power moves are not simulated.',
    version_groups: VERSION_GROUPS, moves, species: Object.fromEntries(Object.entries(species).sort(([a], [b]) => Number(a) - Number(b))) };
  await fs.writeFile(pinned, JSON.stringify(pack) + '\n');
  const empty = Object.entries(species).filter(([, s]) => !s.learnset.length).map(([id]) => id);
  console.log(JSON.stringify({ forms: Object.keys(species).length, moves: Object.keys(moves).length, struggling: empty.length, bytes: (await fs.stat(pinned)).size }));
}

export async function restoreBattle() {
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.copyFile(pinned, output);
  console.log('Copied the pinned battle data');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await fs.mkdir(path.join(root, 'work/companion-catalog-cache'), { recursive: true });
  if (process.argv.includes('--refresh')) await refresh();
  await restoreBattle();
}
