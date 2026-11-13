// Builds public/data/farm.json, the data behind the Resources and Missions tabs:
//   * DE Public Export (ExportRecipes)  -> resources each prime set costs, part recipes included
//   * WFCD/warframe-drop-data           -> mission rewards for those resources and for relics
//   * WFCD/warframe-worldstate-data     -> node and mission type names, to decode DE's world state
//   * the tables below                  -> planet resources and Dark Sector bonuses
// Needs public/data/items.json (run build-data.mjs first) and python3 (see decodeIndex).
// Run with: node scripts/build-farm.mjs
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ITEMS = path.join(ROOT, 'public', 'data', 'items.json');
const OUT = path.join(ROOT, 'public', 'data', 'farm.json');
const JSON_DIR = path.join(ROOT, 'node_modules', '@wfcd', 'items', 'data', 'json');
const EXPORT_BASE = 'https://content.warframe.com/PublicExport';
const DROPS = 'https://raw.githubusercontent.com/WFCD/warframe-drop-data/main/data/all.slim.json';
const WORLDSTATE_DATA = 'https://raw.githubusercontent.com/WFCD/warframe-worldstate-data/master/data';

// Resources that enemies and containers drop on each planet. No data feed has this, so it is kept
// by hand from https://wiki.warframe.com/w/Planet ("Region Resources").
const PLANETS = {
  Mercury: ['Morphics', 'Ferrite', 'Polymer Bundle', 'Detonite Ampule'],
  Venus: ['Alloy Plate', 'Polymer Bundle', 'Circuits', 'Fieldron Sample'],
  Earth: ['Ferrite', 'Rubedo', 'Neurodes', 'Detonite Ampule'],
  Lua: ['Ferrite', 'Rubedo', 'Neurodes', 'Detonite Ampule'],
  Mars: ['Morphics', 'Salvage', 'Gallium', 'Fieldron Sample'],
  Deimos: ['Nano Spores', 'Mutagen Sample', 'Orokin Cell', 'Neurodes'],
  Phobos: ['Rubedo', 'Morphics', 'Plastids', 'Alloy Plate'],
  Ceres: ['Alloy Plate', 'Circuits', 'Orokin Cell', 'Detonite Ampule'],
  Jupiter: ['Salvage', 'Hexenon', 'Neural Sensors', 'Alloy Plate'],
  Europa: ['Morphics', 'Rubedo', 'Fieldron Sample', 'Control Module'],
  Saturn: ['Nano Spores', 'Plastids', 'Orokin Cell', 'Detonite Ampule'],
  Uranus: ['Polymer Bundle', 'Plastids', 'Gallium', 'Detonite Ampule'],
  Neptune: ['Nano Spores', 'Ferrite', 'Control Module', 'Fieldron Sample'],
  Pluto: ['Alloy Plate', 'Rubedo', 'Plastids', 'Morphics', 'Fieldron Sample'],
  Sedna: ['Rubedo', 'Alloy Plate', 'Salvage', 'Detonite Ampule'],
  Eris: ['Nano Spores', 'Plastids', 'Neurodes', 'Mutagen Sample'],
  'Kuva Fortress': ['Salvage', 'Circuits', 'Neural Sensors', 'Detonite Ampule'],
  Void: ['Ferrite', 'Rubedo', 'Argon Crystal', 'Control Module'],
  Zariman: ['Alloy Plate', 'Ferrite', 'Voidgel Orb', 'Entrati Lanthorn'],
};

// Resource drop chance bonus of each Dark Sector node, in percent.
// From https://wiki.warframe.com/w/Dark_Sectors ("Locations").
const DARK_SECTORS = {
  'Earth/Coba': 15, 'Earth/Tikal': 15,
  'Venus/Romula': 10, 'Venus/Malva': 10,
  'Mars/Kadesh': 20, 'Mars/Wahiba': 20,
  'Phobos/Memphis': 25, 'Phobos/Zeugma': 25,
  'Ceres/Seimeni': 35, 'Ceres/Gabii': 35,
  'Jupiter/Sinai': 20, 'Jupiter/Cameria': 20,
  'Europa/Larzac': 25, 'Europa/Cholistan': 25,
  'Saturn/Caracol': 20, 'Saturn/Piscinas': 20,
  'Uranus/Assur': 25, 'Uranus/Ur': 25,
  'Neptune/Yursa': 30, 'Neptune/Kelashin': 30,
  'Pluto/Hieracon': 35, 'Pluto/Sechura': 35,
  'Eris/Zabala': 30, 'Eris/Akkad': 30,
  'Sedna/Amarna': 25, 'Sedna/Sangeru': 25,
};

// PvP and limited time events are not places you can go and farm.
const SKIP_TYPE = /Conclave|Ghoul|Plague Star|Perita/;
// Endless missions pay out in the order A, A, B, C.
const AABC_TYPE = /^(Survival|Defense|Interception|Excavation|Disruption|Mobile Defense)$/;

async function fetchOk(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res;
}

// DE's export index is LZMA compressed. Node has no LZMA and python3 ships with it, so this saves
// adding a dependency for one small file.
function decodeIndex(buffer) {
  const code = 'import lzma,sys;sys.stdout.buffer.write(lzma.LZMADecompressor(format=lzma.FORMAT_ALONE).decompress(sys.stdin.buffer.read()))';
  return execFileSync('python3', ['-I', '-c', code], { input: buffer }).toString('utf8');
}

async function loadRecipes() {
  const index = decodeIndex(Buffer.from(await (await fetchOk(`${EXPORT_BASE}/index_en.txt.lzma`)).arrayBuffer()));
  const file = index.split(/\s+/).find((line) => line.startsWith('ExportRecipes_en'));
  if (!file) throw new Error('ExportRecipes is not listed in the export index');
  // DE's exports can hold raw control characters, which JSON.parse rejects.
  const text = (await (await fetchOk(`${EXPORT_BASE}/Manifest/${file}`)).text()).replace(/[\u0000-\u001f]/g, ' ');
  const byResult = new Map();
  for (const r of JSON.parse(text).ExportRecipes) if (!byResult.has(r.resultType)) byResult.set(r.resultType, r);
  return byResult;
}

function resourceNames() {
  const names = new Map();
  for (const file of ['Resources.json', 'Misc.json']) {
    for (const i of require(path.join(JSON_DIR, file))) if (i.name) names.set(i.uniqueName, i.name);
  }
  return names;
}

// Total resources for one set: the main blueprint plus the recipe of each part.
function setCost(id, recipes, names, setIds) {
  const cost = {};
  const walk = (uid, times, depth) => {
    const recipe = recipes.get(uid);
    if (!recipe || depth > 4) return;
    for (const { ItemType: type, ItemCount: count } of recipe.ingredients) {
      // A finished prime item used as an ingredient is tracked as a part, it costs nothing extra here.
      if (setIds.has(type)) continue;
      if (recipes.has(type) && type.includes('Prime')) walk(type, times * count, depth + 1);
      else if (names.has(type)) cost[names.get(type)] = (cost[names.get(type)] ?? 0) + times * count;
    }
  };
  walk(id, 1, 0);
  return cost;
}

function parseQuantity(item) {
  const m = item.match(/^([\d,]+)X\s+(.+)$/);
  return m ? [Number(m[1].replace(/,/g, '')), m[2]] : [1, item];
}

function buildMissions(slim, wanted) {
  const places = new Map();
  for (const d of slim) {
    const m = d.place.replace(/<\/?b>/g, '').match(/^([^/]+)\/(.+?) \((.+?)\)(?:, Rotation ([A-C]))?$/);
    if (!m || !PLANETS[m[1]] || SKIP_TYPE.test(m[3])) continue;
    const [, planet, node, type, rotation = ''] = m;
    const [qty, item] = parseQuantity(d.item);
    const key = `${planet}/${node}/${type}`;
    if (!places.has(key)) places.set(key, { planet, node, type, rotations: new Set(), rows: [] });
    const place = places.get(key);
    place.rotations.add(rotation);
    if (wanted(item)) place.rows.push({ item, rotation, expected: (qty * d.chance) / 100 });
  }

  const missions = [];
  for (const { planet, node, type, rotations, rows } of places.values()) {
    const aabc = AABC_TYPE.test(type) && rotations.has('A');
    const share = (r) => (aabc ? (r === 'A' ? 0.5 : 0.25) : 1 / rotations.size);
    const items = new Map();
    for (const { item, rotation, expected } of rows) {
      if (!items.has(item)) items.set(item, new Map());
      const byRotation = items.get(item);
      byRotation.set(rotation, (byRotation.get(rotation) ?? 0) + expected);
    }
    const rewards = [...items].map(([item, byRotation]) => {
      const [best] = [...byRotation].sort((a, b) => b[1] - a[1])[0];
      const perReward = [...byRotation].reduce((total, [r, expected]) => total + share(r) * expected, 0);
      return { i: item, e: Number(perReward.toFixed(4)), r: best };
    });
    const bonus = DARK_SECTORS[`${planet}/${node}`] ?? 0;
    missions.push({ planet, node, type, bonus, rewards });
  }
  return missions.sort((a, b) => a.planet.localeCompare(b.planet) || a.node.localeCompare(b.node) || a.type.localeCompare(b.type));
}

async function main() {
  const items = JSON.parse(await readFile(ITEMS, 'utf8'));
  const [recipeMap, slim, solNodes, missionTypes] = await Promise.all([
    loadRecipes(),
    fetchOk(DROPS).then((r) => r.json()),
    fetchOk(`${WORLDSTATE_DATA}/solNodes.json`).then((r) => r.json()),
    fetchOk(`${WORLDSTATE_DATA}/missionTypes.json`).then((r) => r.json()),
  ]);
  // DE's world state names nodes and mission types by code ("SolNode205", "MT_EXTERMINATION").
  // nodes: code -> [node, planet, enemy, mission type]
  const nodes = {};
  for (const [id, n] of Object.entries(solNodes)) {
    const m = String(n.value ?? '').match(/^(.*) \((.*)\)$/);
    if (m) nodes[id] = [m[1], m[2], n.enemy ?? '', n.type ?? ''];
  }
  const types = Object.fromEntries(Object.entries(missionTypes).map(([k, v]) => [k, v.value]));

  const names = resourceNames();
  const setIds = new Set(Object.values(items.sets).map((s) => s.id));
  const recipes = {};
  for (const [set, { id }] of Object.entries(items.sets)) {
    const cost = setCost(id, recipeMap, names, setIds);
    if (Object.keys(cost).length) recipes[set] = cost;
  }
  // Some sets (bows, dual weapons) legitimately cost only their parts, about one in eight. Far more
  // than that means the export changed format, and yesterday's file is better than an empty one.
  if (Object.keys(recipes).length < Object.keys(items.sets).length * 0.75) {
    throw new Error(`Only ${Object.keys(recipes).length} of ${Object.keys(items.sets).length} sets have a recipe`);
  }

  const resources = [...new Set(Object.values(recipes).flatMap(Object.keys))].sort();
  const needed = new Set(resources);
  const missions = buildMissions(slim, (item) => needed.has(item) || / Relic$/.test(item));

  const out = {
    generatedAt: new Date().toISOString(),
    sources: { recipes: 'DE Public Export', drops: 'WFCD/warframe-drop-data', planets: 'wiki.warframe.com', nodes: 'WFCD/warframe-worldstate-data' },
    resources,
    recipes,
    planets: PLANETS,
    missions,
    nodes,
    missionTypes: types,
  };

  // Skip the write when only the timestamp would change, so the daily job commits real changes only.
  let previous = null;
  try {
    previous = JSON.parse(await readFile(OUT, 'utf8'));
  } catch {}
  if (previous && JSON.stringify({ ...previous, generatedAt: null }) === JSON.stringify({ ...out, generatedAt: null })) {
    console.log('farm.json unchanged');
    return;
  }
  await writeFile(OUT, JSON.stringify(out));
  console.log(`farm.json: ${Object.keys(recipes).length} set recipes, ${resources.length} resources, ${missions.length} missions`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
