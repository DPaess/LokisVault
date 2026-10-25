// Fetches warframe.market prices for every prime part, prime set and relic that
// public/data/items.json knows about, and writes public/data/prices.json.
//
// warframe.market asks clients to stay under 3 requests per second, so this runs
// sequentially and takes several minutes. It is meant for the scheduled GitHub
// Action, not for the browser (the site only reads the resulting JSON).
//
// Usage: node scripts/fetch-prices.mjs [--limit N]
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ITEMS = path.join(ROOT, 'public', 'data', 'items.json');
const OUT = path.join(ROOT, 'public', 'data', 'prices.json');
const API = 'https://api.warframe.market/v2';
const HEADERS = {
  Accept: 'application/json',
  Language: 'en',
  Platform: 'pc',
  Crossplay: 'true',
  'User-Agent': 'LokisVault (+https://github.com/DPaess/LokisVault)',
};
const DELAY_MS = 380; // about 2.6 requests per second

const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > 0 ? Number(process.argv[limitArg + 1]) : Infinity;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function get(url, attempt = 1) {
  const res = await fetch(url, { headers: HEADERS });
  if (res.status === 429 || res.status >= 500) {
    if (attempt > 5) throw new Error(`${url} -> HTTP ${res.status} after retries`);
    await sleep(2000 * attempt);
    return get(url, attempt + 1);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

// Orders from players who are online or in game are the only ones you can actually trade with.
const isLive = (o) => ['ingame', 'online'].includes(o?.user?.status);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

// Relic orders carry a refinement subtype; we price the intact relic. Mods carry a rank; we want unranked.
const isBase = (o) => !o.rank && (!o.subtype || o.subtype === 'intact');

function summarize(top) {
  const data = top?.data ?? top ?? {};
  const sell = (data.sell || []).filter(isLive).filter(isBase).map((o) => o.platinum).sort((a, b) => a - b);
  const buy = (data.buy || []).filter(isLive).filter(isBase).map((o) => o.platinum).sort((a, b) => b - a);
  if (!sell.length && !buy.length) return null;
  return {
    sell: sell[0] ?? null, // cheapest live seller
    sellMed: median(sell.slice(0, 5)), // typical price among the cheapest five
    buy: buy[0] ?? null, // best live buy order
    sellers: sell.length,
  };
}

async function main() {
  const items = JSON.parse(await readFile(ITEMS, 'utf8'));
  const wanted = new Map(); // normalized name -> our name
  for (const name of Object.keys(items.parts)) wanted.set(norm(name), name);
  for (const name of Object.keys(items.sets)) wanted.set(norm(`${name} Set`), `${name} Set`);
  for (const name of Object.keys(items.relics)) wanted.set(norm(`${name} Relic`), `${name} Relic`);

  const catalog = await get(`${API}/items`);
  const list = catalog?.data ?? [];
  if (!Array.isArray(list) || !list.length) throw new Error('Unexpected /v2/items response shape');

  const slugs = new Map(); // our name -> { slug, ducats }
  for (const it of list) {
    const name = it?.i18n?.en?.name ?? it?.name;
    if (!name) continue;
    let ours = wanted.get(norm(name));
    // Market sometimes drops the trailing "Blueprint" on frame parts or adds it.
    if (!ours) ours = wanted.get(norm(`${name} Blueprint`)) ?? wanted.get(norm(name.replace(/ Blueprint$/, '')));
    if (ours) slugs.set(ours, { slug: it.slug, ducats: it.ducats ?? null });
  }
  const missing = [...wanted.values()].filter((n) => !slugs.has(n) && !/Relic$/.test(n));
  console.log(`Matched ${slugs.size} of ${wanted.size} names on warframe.market`);
  if (missing.length) console.log(`Unmatched (non relic): ${missing.slice(0, 40).join(', ')}${missing.length > 40 ? ' ...' : ''}`);

  let previous = {};
  try {
    previous = JSON.parse(await readFile(OUT, 'utf8')).prices ?? {};
  } catch {}

  const prices = {};
  let done = 0;
  let failures = 0;
  const entries = [...slugs.entries()].slice(0, LIMIT);
  for (const [name, { slug, ducats }] of entries) {
    try {
      const top = await get(`${API}/orders/item/${slug}/top`);
      const s = summarize(top);
      if (s) prices[name] = { ...s, slug, ...(ducats != null ? { ducats } : {}) };
      else prices[name] = { slug, sell: null, buy: null, sellers: 0 };
    } catch (err) {
      failures++;
      if (previous[name]) prices[name] = { ...previous[name], stale: true };
      console.warn(`! ${name}: ${err.message}`);
    }
    done++;
    if (done % 100 === 0) console.log(`${done}/${entries.length}`);
    await sleep(DELAY_MS);
  }

  if (failures > entries.length / 2) throw new Error(`Too many failures (${failures}), keeping the previous prices.json`);

  await writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), source: 'warframe.market v2, live orders only', prices }));
  console.log(`prices.json: ${Object.keys(prices).length} items, ${failures} failures`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
