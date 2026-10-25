// Builds public/data/items.json from community data sources:
//   * @wfcd/items (npm)              -> masterable items, prime sets, components, ducats
//   * WFCD/warframe-drop-data (raw)  -> relic reward tables and which relics drop today
// Run with: node scripts/build-data.mjs
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'data', 'items.json');
const DROP_BASE = 'https://raw.githubusercontent.com/WFCD/warframe-drop-data/main/data';

const ITEM_FILES = {
  'Warframes.json': 'Warframe',
  'Primary.json': 'Primary',
  'Secondary.json': 'Secondary',
  'Melee.json': 'Melee',
  'Arch-Gun.json': 'Archwing',
  'Arch-Melee.json': 'Archwing',
  'Archwing.json': 'Archwing',
  'Sentinels.json': 'Companion',
  'SentinelWeapons.json': 'Companion',
  'Pets.json': 'Companion',
  'Misc.json': 'Modular',
};

// Types that give 200 mastery per rank instead of 100.
const FRAME_LIKE = new Set(['Warframe', 'Necramech', 'Archwing', 'Sentinel', 'Pets', 'K-Drive Component']);

const ITEMS_DIR = path.join(ROOT, 'node_modules', '@wfcd', 'items');
const loadItems = (file) => require(path.join(ITEMS_DIR, 'data', 'json', file));

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

function rarityFromIntactChance(chance) {
  if (chance > 20) return 'common';
  if (chance > 5) return 'uncommon';
  return 'rare';
}

function categoryFor(item, fileCategory) {
  if (item.type === 'Necramech') return 'Necramech';
  if (item.type === 'Zaw Component') return 'Modular';
  if (item.type === 'Companion Weapon') return 'Companion';
  return fileCategory;
}

async function main() {
  const pkg = JSON.parse(await readFile(path.join(ITEMS_DIR, 'package.json'), 'utf8'));
  const components = new Map(loadItems('Components.json').map((c) => [c.uniqueName, c]));

  // ---- Masterable items and prime sets ---------------------------------
  const mastery = [];
  const sets = {};
  const parts = {};
  const seen = new Set();

  for (const [file, fileCategory] of Object.entries(ITEM_FILES)) {
    for (const item of loadItems(file)) {
      if (!item.masterable || seen.has(item.uniqueName)) continue;
      seen.add(item.uniqueName);
      const cap = item.maxLevelCap || 30;
      const perRank = FRAME_LIKE.has(item.type) ? 200 : 100;
      const category = categoryFor(item, fileCategory);
      const isPrime = Boolean(item.isPrime) || / Prime$/.test(item.name);
      mastery.push({
        id: item.uniqueName,
        name: item.name,
        category,
        type: item.type,
        prime: isPrime,
        xp: cap * perRank,
        mr: item.masteryReq || 0,
        vaulted: Boolean(item.vaulted),
      });

      if (!isPrime) continue;
      const setParts = [];
      for (const ref of item.components || []) {
        const comp = components.get(ref.uniqueName);
        if (!comp || !comp.tradable) continue;
        const rewardNames = new Set((comp.drops || []).filter((d) => /Relic/.test(d.location)).map((d) => d.type));
        if (rewardNames.size !== 1) continue;
        const partName = [...rewardNames][0];
        setParts.push({ name: partName, count: ref.itemCount || 1 });
        parts[partName] ??= { ducats: comp.ducats || 0, sets: [] };
        if (!parts[partName].sets.includes(item.name)) parts[partName].sets.push(item.name);
      }
      if (setParts.length) {
        sets[item.name] = { id: item.uniqueName, category, type: item.type, vaulted: Boolean(item.vaulted), parts: setParts };
      }
    }
  }

  // ---- Relic tables -----------------------------------------------------
  const [relicData, missionDrops, info] = await Promise.all([
    fetchJson(`${DROP_BASE}/relics.json`),
    fetchJson(`${DROP_BASE}/all.slim.json`),
    fetchJson(`${DROP_BASE}/info.json`),
  ]);

  const droppingNow = new Set(
    missionDrops.filter((d) => /Relic$/.test(d.item)).map((d) => d.item.replace(/ Relic$/, '')),
  );

  const relics = {};
  for (const r of relicData.relics) {
    const key = `${r.tier} ${r.relicName}`;
    relics[key] ??= { era: r.tier, rewards: {}, farmable: droppingNow.has(key) };
    const state = r.state.toLowerCase();
    for (const w of r.rewards) {
      const entry = (relics[key].rewards[w.itemName] ??= { item: w.itemName, chance: {} });
      entry.chance[state] = w.chance;
    }
  }
  for (const relic of Object.values(relics)) {
    relic.rewards = Object.values(relic.rewards)
      .map((w) => ({ ...w, rarity: rarityFromIntactChance(w.chance.intact ?? 0) }))
      .sort((a, b) => (b.chance.intact ?? 0) - (a.chance.intact ?? 0));
  }

  // Prime rewards that belong to non-masterable items (e.g. Kavasa Prime collar parts).
  const ducatsByReward = new Map();
  for (const comp of components.values()) {
    for (const d of comp.drops || []) if (/Relic/.test(d.location)) ducatsByReward.set(d.type, comp.ducats || 0);
  }
  for (const relic of Object.values(relics)) {
    for (const w of relic.rewards) {
      if (!parts[w.item] && / Prime /.test(` ${w.item} `)) parts[w.item] = { ducats: ducatsByReward.get(w.item) || 0, sets: [] };
    }
  }

  // Reverse index: which relics contain each prime part.
  const relicsByPart = {};
  for (const [key, relic] of Object.entries(relics)) {
    for (const w of relic.rewards) (relicsByPart[w.item] ??= []).push(key);
  }
  for (const [name, p] of Object.entries(parts)) {
    p.relics = (relicsByPart[name] || []).sort();
    p.farmable = p.relics.some((k) => relics[k]?.farmable);
  }

  const eraOrder = { Lith: 0, Meso: 1, Neo: 2, Axi: 3, Requiem: 4 };
  const sortedRelics = Object.fromEntries(
    Object.entries(relics).sort(([a, ra], [b, rb]) =>
      (eraOrder[ra.era] ?? 9) - (eraOrder[rb.era] ?? 9) || a.localeCompare(b, 'en', { numeric: true })),
  );

  mastery.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

  const out = {
    generatedAt: new Date().toISOString(),
    sources: {
      items: `@wfcd/items ${pkg.version}`,
      drops: `WFCD/warframe-drop-data, DE drop tables modified ${new Date(info.modified).toISOString()}`,
    },
    relics: sortedRelics,
    sets,
    parts,
    mastery,
  };

  // Skip the write when only the timestamp would change, so the daily job commits real changes only.
  let previous = null;
  try {
    previous = JSON.parse(await readFile(OUT, 'utf8'));
  } catch {}
  if (previous && JSON.stringify({ ...previous, generatedAt: null }) === JSON.stringify({ ...out, generatedAt: null })) {
    console.log('items.json unchanged');
    return;
  }
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out));
  console.log(
    `items.json: ${mastery.length} masterable, ${Object.keys(sets).length} prime sets, ` +
      `${Object.keys(parts).length} prime parts, ${Object.keys(relics).length} relics ` +
      `(${Object.values(relics).filter((r) => r.farmable).length} dropping now)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
