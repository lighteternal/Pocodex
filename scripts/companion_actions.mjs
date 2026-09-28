/** Pin exact-form PMD action sheets, shared Emerald effects and the FireRed intro Oak; restore offline at build time. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readUrl, mapLimit } from './companion_catalog.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pinned = path.join(root, 'companion/data/actions.json');
const output = path.join(root, 'companion/assets');
const revision = '904f12e3fe8438ea5e53282ae1282831bd2b5124';
const base = `https://raw.githubusercontent.com/PMDCollab/SpriteCollab/${revision}`;
const effectsRevision = 'c925b8482d05fb882d6b64e523653cae599e025f';
const introRevision = '037335f4c725d7c9aecdac87066f2002b4bd7e14';
// Buddy actions first; the rest animate battles.
const actions = ['Idle', 'Walk', 'Sleep', 'Eat', 'Pose', 'Nod', 'Attack', 'Hurt', 'Charge', 'Shoot', 'Hop'];
const hash = data => createHash('sha256').update(data).digest('hex');
const tag = (text, name) => text.match(new RegExp(`<${name}>([^<]+)</${name}>`))?.[1];

export function parseActions(xml) {
  const blocks = new Map([...xml.matchAll(/<Anim>([\s\S]*?)<\/Anim>/g)].map(m => [tag(m[1], 'Name'), m[1]]));
  const result = {};
  for (const name of actions) {
    let block = blocks.get(name);
    if (!block) continue;
    const sheet = tag(block, 'CopyOf') || name;
    block = blocks.get(sheet);
    if (!block || tag(block, 'CopyOf')) throw new Error(`Invalid animation alias: ${name}`);
    const width = Number(tag(block, 'FrameWidth')), height = Number(tag(block, 'FrameHeight'));
    const durations = [...block.matchAll(/<Duration>(\d+)<\/Duration>/g)].map(m => Number(m[1]));
    if (!width || !height || !durations.length || durations.some(n => n <= 0)) throw new Error(`Invalid animation dimensions/timing: ${name}`);
    result[name] = { sheet, width, height, durations };
  }
  return result;
}

export function formEntry(pokemon, tracker) {
  const key = String(pokemon.species_id).padStart(4, '0');
  const entry = tracker[key];
  if (!entry) return null;
  if (pokemon.default) return { folder: key, entry };
  if (pokemon.slug.includes('-totem-')) return null;
  const regional = pokemon.slug.match(/-(alola|galar|hisui)$/)?.[1];
  const names = { 'pikachu-alola-cap': 'Alola_Cap', 'tauros-paldea-combat-breed': 'Paldea',
    'tauros-paldea-blaze-breed': 'Paldea_Blaze', 'tauros-paldea-aqua-breed': 'Paldea_Aqua' };
  const name = regional || names[pokemon.slug];
  if (!name) return null; // Never silently substitute a regional, costume or Totem form.
  const match = Object.entries(entry.subgroups || {}).find(([, form]) => form.name.toLowerCase() === name.toLowerCase() && form.canon);
  return match ? { folder: `${key}/${match[0]}`, entry: match[1] } : null;
}

async function refresh() {
  const tracker = await readUrl(`${base}/tracker.json`, false, 64 * 1024 * 1024);
  const creditsText = (await readUrl(`${base}/credit_names.txt`, true)).toString('utf8');
  const credits = new Map(creditsText.trim().split('\n').slice(1).map(line => { const [name, id] = line.trim().split('\t'); return [id, name]; }));
  const catalog = JSON.parse(await fs.readFile(path.join(root, 'companion/data/catalog.json')));
  const manifest = [], species = {}, missing = [];
  async function save(url, file) {
    const bytes = await readUrl(url, true);
    const entry = { file, url, sha256: hash(bytes), bytes: bytes.length };
    manifest.push(entry);
    await fs.writeFile(path.join(output, file), bytes);
    return bytes;
  }
  await mapLimit(catalog.species, async pokemon => {
    const match = formEntry(pokemon, tracker);
    if (!match || !Object.keys(match.entry.sprite_files).length) { missing.push(pokemon.slug); return; }
    const xml = await save(`${base}/sprite/${match.folder}/AnimData.xml`, `${pokemon.id}-actions.xml`);
    const parsed = parseActions(xml.toString('utf8'));
    const files = new Map();
    for (const action of Object.values(parsed)) {
      const file = `${pokemon.id}-action-${action.sheet}.png`;
      if (!files.has(file)) files.set(file, await save(`${base}/sprite/${match.folder}/${action.sheet}-Anim.png`, file));
      const png = files.get(file);
      if (png.subarray(1, 4).toString() !== 'PNG') throw new Error(`Invalid action sheet: ${file}`);
      const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
      if (w !== action.width * action.durations.length || ![1, 8].includes(h / action.height)) throw new Error(`Sheet grid mismatch: ${file}`);
      action.file = file; action.directions = h / action.height;
      delete action.sheet;
    }
    const credit = match.entry.sprite_credit;
    const ids = [credit.primary, ...(Array.isArray(credit.secondary) ? credit.secondary : String(credit.secondary || '').split(' '))].filter(Boolean);
    species[pokemon.id] = { folder: match.folder, credits: [...new Set(ids.map(id => credits.get(id) || id))], actions: parsed };
  });
  const effects = {};
  for (const [name, source, width, height] of [
    ['heart', 'field_effects/pics/emotion_heart', 16, 16],
    ['question', 'field_effects/pics/emotion_question', 16, 16],
    ['sparkle', 'field_effects/pics/small_sparkle', 16, 16],
    ['berry', 'items/icons/oran_berry', 24, 24],
  ]) {
    const file = `effect-${name}.png`;
    const data = await save(`https://raw.githubusercontent.com/pret/pokeemerald/${effectsRevision}/graphics/${source}.png`, file);
    effects[name] = { file, width, height, columns: data.readUInt32BE(16) / width, rows: data.readUInt32BE(20) / height };
  }
  // Professor Oak from FireRed's own intro; palette index zero is the backdrop, keyed out by the renderer.
  const oak = await save(`https://raw.githubusercontent.com/pret/pokefirered/${introRevision}/graphics/oak_speech/oak/pic.png`, 'intro-oak.png');
  const intro = { oak: { file: 'intro-oak.png', width: oak.readUInt32BE(16), height: oak.readUInt32BE(20) } };
  await save(`${base}/LICENSE.md`, 'ACTIONS-LICENSE.md');
  const pack = { revision, effects_revision: effectsRevision, intro_revision: introRevision, source: 'https://github.com/PMDCollab/SpriteCollab',
    rights: 'SpriteCollab contributions: CC BY-NC 4.0; Pokemon and original game artwork rights remain with their owners.',
    species: Object.fromEntries(Object.entries(species).sort(([a], [b]) => Number(a) - Number(b))), missing: missing.sort(), effects, intro,
    manifest: manifest.sort((a, b) => a.file.localeCompare(b.file)) };
  await fs.writeFile(pinned, JSON.stringify(pack, null, 2) + '\n');
  console.log(JSON.stringify({ forms: Object.keys(species).length, missing, files: manifest.length, bytes: manifest.reduce((sum, a) => sum + a.bytes, 0) }));
}

export async function restoreActions() {
  await fs.mkdir(output, { recursive: true });
  await fs.mkdir(path.join(root, 'work/companion-catalog-cache'), { recursive: true });
  const pack = JSON.parse(await fs.readFile(pinned));
  await mapLimit(pack.manifest, async entry => {
    if (!/^(\d+-actions\.xml|\d+-action-[A-Za-z]+\.png|effect-[a-z]+\.png|intro-[a-z]+\.png|ACTIONS-LICENSE\.md)$/.test(entry.file)) throw new Error('Invalid action asset filename');
    const destination = path.join(output, entry.file);
    let data;
    try { data = await fs.readFile(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!data) data = await readUrl(entry.url, true);
    if (data.length !== entry.bytes || hash(data) !== entry.sha256) throw new Error(`Pinned action asset changed: ${entry.file}`);
    await fs.writeFile(destination, data);
  });
  await fs.copyFile(pinned, path.join(output, 'actions.json'));
  console.log(`Verified ${pack.manifest.length} pinned action resources`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await fs.mkdir(output, { recursive: true });
  await fs.mkdir(path.join(root, 'work/companion-catalog-cache'), { recursive: true });
  if (process.argv.includes('--refresh')) await refresh();
  await restoreActions();
}
