/** Build a pinned, inspectable local roster; no PokeTokenBar code or assets. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, 'work', 'companion-catalog-cache');
const output = path.join(root, 'companion', 'assets');
const idOf = url => Number(url.split('/').filter(Boolean).at(-1));
const words = name => name.replaceAll('-', ' ');
const title = name => words(name).replace(/\b\w/g, c => c.toUpperCase());

export function audioFormat(data) {
  if (data.subarray(0, 4).toString() === 'OggS') return 'ogg';
  if (data.subarray(0, 3).toString() === 'ID3' || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0)) return 'mp3';
  throw new Error('Unsupported audio signature');
}

export function adaptRule(details) {
  const d = details[0];
  if (!d || !['level-up', 'trade', 'use-item', 'use-move', 'three-critical-hits', 'take-damage', 'other'].includes(d.trigger?.name)) {
    throw new Error(`Unsupported evolution trigger: ${d?.trigger?.name}`);
  }
  const special = d.trigger.name !== 'level-up' || ['min_happiness', 'min_beauty', 'min_affection', 'known_move', 'known_move_type', 'held_item', 'location', 'time_of_day', 'gender', 'relative_physical_stats', 'party_species', 'party_type', 'needs_overworld_rain', 'turn_upside_down'].some(k => d[k] !== null && d[k] !== undefined && d[k] !== '' && d[k] !== false);
  const level = d.min_level || 1;
  const requirement = !special ? `Level ${level}` : d.item ? `Earn ${words(d.item.name)}: 1 active hour together` : d.trigger.name === 'trade' ? '1 active hour together (solo trade alternative)' : '1 active hour together (companion adaptation)';
  return { min_level: level, active_seconds: special ? 3600 : 0, requirement: special && level > 1 ? `${requirement} + level ${level}` : requirement, canonical: d.trigger.name, adapted: special };
}

export async function readUrl(url, binary = false, limit = 8 * 1024 * 1024) {
  const name = createHash('sha256').update(url).digest('hex');
  const dest = path.join(cache, name);
  try { const buf = await fs.readFile(dest); return binary ? buf : JSON.parse(buf); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, { signal: AbortSignal.timeout(25000) });
    if (!response.ok) {
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        console.warn(`Transient asset response ${response.status}; retry ${attempt + 1}`);
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }
      throw new Error(`Catalog download failed: HTTP ${response.status} ${url}`);
    }
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > limit) throw new Error(`Resource exceeds asset size limit: ${url}`);
    await fs.writeFile(dest, buf);
    return binary ? buf : JSON.parse(buf);
  }
}

export async function mapLimit(items, fn) {
  let index = 0;
  const result = new Array(items.length);
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (index < items.length) { const i = index++; result[i] = await fn(items[i]); }
  }));
  return result;
}

const regionalPaths = [
  ['rattata-alola', 'raticate-alola', 20], ['sandshrew-alola', 'sandslash-alola', 1],
  ['vulpix-alola', 'ninetales-alola', 1], ['diglett-alola', 'dugtrio-alola', 26],
  ['meowth-alola', 'persian-alola', 1], ['meowth-galar', 'perrserker', 28],
  ['geodude-alola', 'graveler-alola', 25], ['graveler-alola', 'golem-alola', 1],
  ['grimer-alola', 'muk-alola', 38], ['ponyta-galar', 'rapidash-galar', 40],
  ['slowpoke-galar', 'slowbro-galar', 1], ['slowpoke-galar', 'slowking-galar', 1],
  ['farfetchd-galar', 'sirfetchd', 1], ['mr-mime-galar', 'mr-rime', 42],
  ['growlithe-hisui', 'arcanine-hisui', 1], ['voltorb-hisui', 'electrode-hisui', 1],
  ['pikachu', 'raichu-alola', 1], ['exeggcute', 'exeggutor-alola', 1],
  ['cubone', 'marowak-alola', 28], ['koffing', 'weezing-galar', 35], ['mime-jr', 'mr-mime-galar', 1],
];

export async function buildCatalog() {
  await fs.mkdir(cache, { recursive: true });
  await fs.mkdir(output, { recursive: true });
  console.log('Reading species and complete evolution families');
  const seeds = await mapLimit(Array.from({ length: 151 }, (_, i) => i + 1), id => readUrl(`https://pokeapi.co/api/v2/pokemon-species/${id}/`));
  const chainUrls = [...new Set(seeds.map(s => s.evolution_chain.url))];
  const chains = await mapLimit(chainUrls, url => readUrl(url));
  const nodes = new Map();
  function walk(node, family, parent = null) {
    const id = idOf(node.species.url);
    nodes.set(id, { id, name: node.species.name, family, parent, edges: node.evolves_to.map(child => ({ to: idOf(child.species.url), ...adaptRule(child.evolution_details), canonical_details: child.evolution_details })) });
    node.evolves_to.forEach(child => walk(child, family, id));
  }
  chains.forEach(chain => walk(chain.chain, chain.id));
  const species = await mapLimit([...nodes.keys()], id => seeds.find(s => s.id === id) || readUrl(`https://pokeapi.co/api/v2/pokemon-species/${id}/`));
  const wanted = species.flatMap(s => s.varieties.filter(v => v.is_default || /-(alola|galar|hisui|paldea)(-|$)/.test(v.pokemon.name)).map(v => ({ ...v, species: s })));
  console.log(`Reading ${wanted.length} forms and downloading sprites/cries`);
  const manifest = [];
  const pokemon = await mapLimit(wanted, async entry => {
    const p = await readUrl(entry.pokemon.url);
    const meta = nodes.get(entry.species.id);
    const sprite = p.sprites.other?.showdown?.front_default || p.sprites.front_default;
    if (!sprite) throw new Error(`No sprite for ${p.name}`);
    const cry = p.cries?.latest;
    if (!cry) throw new Error(`No cry for ${p.name}`);
    const saved = {};
    for (const [kind, url] of [['sprite', sprite], ['cry', cry]]) {
      const data = await readUrl(url, true);
      const ext = kind === 'cry' ? audioFormat(data) : new URL(url).pathname.endsWith('.gif') ? 'gif' : 'png';
      if (ext === 'gif' && data.subarray(0, 3).toString() !== 'GIF') throw new Error(`Invalid GIF for ${p.name}`);
      const filename = `${p.id}-${kind}.${ext}`;
      await fs.writeFile(path.join(output, filename), data);
      saved[kind] = filename;
      manifest.push({ id: p.id, kind, file: filename, url, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length, rights: 'Pokémon third-party content; redistribution rights unresolved' });
    }
    return { id: p.id, species_id: entry.species.id, slug: p.name, name: title(p.name), family: meta.family,
      starter: entry.is_default && meta.parent === null, legendary: entry.species.is_legendary || entry.species.is_mythical,
      types: p.types.map(t => t.type.name), evolutions: entry.is_default ? meta.edges : [], ...saved,
      sprite_style: sprite.endsWith('.gif') ? 'animated battle sprite' : 'static sprite', default: entry.is_default };
  });
  const bySlug = new Map(pokemon.map(p => [p.slug, p]));
  const restrictedTargets = new Set(['sirfetchd', 'perrserker', 'mr-rime']);
  pokemon.forEach(p => { p.evolutions = p.evolutions.filter(e => !restrictedTargets.has(pokemon.find(x => x.id === e.to)?.slug)); });
  for (const [from, to, level] of regionalPaths) {
    const source = bySlug.get(from), target = bySlug.get(to);
    if (!source || !target) throw new Error(`Regional family asset gap: ${from} -> ${to}`);
    source.evolutions.push({ to: target.id, min_level: level, active_seconds: level === 1 ? 3600 : 0,
      requirement: level === 1 ? '1 active hour together (regional companion adaptation)' : `Level ${level} · choose regional evolution`,
      canonical: 'regional-route', adapted: true });
    if (!source.default && !regionalPaths.some(([, end]) => end === from)) source.starter = true;
  }
  for (const p of pokemon) {
    if (!p.default && !regionalPaths.some(([start, end]) => start === p.slug || end === p.slug)) p.starter = !nodes.get(p.species_id).parent;
    for (const edge of p.evolutions) if (!pokemon.some(other => other.id === edge.to)) throw new Error(`Missing evolution destination ${edge.to}`);
  }
  const catalog = { version: 1, generated_at: new Date().toISOString(), source: 'https://pokeapi.co/docs/v2/',
    policy: 'Pinned Kanto families; modern species data, explicit solo adaptations and regional route overrides. See spec.',
    species: pokemon.sort((a, b) => a.id - b.id) };
  await fs.writeFile(path.join(output, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest.sort((a,b) => a.file.localeCompare(b.file)), null, 2) + '\n');
  console.log(JSON.stringify({ forms: pokemon.length, families: chains.length, assets: manifest.length, bytes: manifest.reduce((n, a) => n + a.bytes, 0) }));
}

export async function restoreAssets() {
  const pinned = path.join(root, 'companion', 'data');
  const manifest = JSON.parse(await fs.readFile(path.join(pinned, 'manifest.json'), 'utf8'));
  await fs.mkdir(cache, { recursive: true });
  await fs.mkdir(output, { recursive: true });
  await mapLimit(manifest, async entry => {
    if (!/^\d+-(sprite|cry)\.(gif|png|mp3|ogg)$/.test(entry.file)) throw new Error('Invalid pinned asset filename');
    const destination = path.join(output, entry.file);
    let data;
    try { data = await fs.readFile(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!data) data = await readUrl(entry.url, true);
    if (data.length !== entry.bytes || createHash('sha256').update(data).digest('hex') !== entry.sha256) {
      throw new Error(`Pinned asset changed: ${entry.file}. Review the upstream source; do not silently accept it.`);
    }
    await fs.writeFile(destination, data);
  });
  await fs.copyFile(path.join(pinned, 'catalog.json'), path.join(output, 'catalog.json'));
  await fs.copyFile(path.join(pinned, 'manifest.json'), path.join(output, 'manifest.json'));
  console.log(`Verified ${manifest.length} pinned assets`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--refresh-catalog')) await buildCatalog();
  else await restoreAssets();
}
