// Loki's Vault: all UI logic. Vanilla ES module, no build step.
// Game data comes from data/items.json and data/prices.json (built by scripts/).
// The player's inventory lives in localStorage under STORE_KEY.

import { readImages, combinePasses, createFuzzy } from './ocr.js';

const STORE_KEY = 'lokisvault:v1';
const REFS = ['intact', 'exceptional', 'flawless', 'radiant'];
const REF_LABEL = { intact: 'Intact', exceptional: 'Exceptional', flawless: 'Flawless', radiant: 'Radiant' };

const view = document.getElementById('view');
let DATA = null; // items.json
let PRICES = {}; // prices.json -> prices
let PRICES_AT = null;
let state = null;
const ui = {}; // per tab filters and transient UI state, not persisted

// ---- Helpers ---------------------------------------------------------------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const fmtNum = (n, digits = 0) => (n == null ? '–' : Number(n).toLocaleString('en', { maximumFractionDigits: digits }));
const fmtP = (n, digits = 0) => (n == null ? '–' : `${fmtNum(n, digits)}p`);
const fmtD = (n, digits = 0) => (n == null ? '–' : `${fmtNum(n, digits)} d`);
const fmtPct = (n) => (n == null ? '–' : `${fmtNum(n, 1)}%`);
const pct = (a, b) => (b ? Math.min(100, (a / b) * 100) : 0);
const bar = (a, b) => `<div class="bar"><span style="width:${pct(a, b).toFixed(1)}%"></span></div>`;

const priceEntry = (name) => PRICES[name] ?? null;
const priceOf = (name) => PRICES[name]?.sellMed ?? PRICES[name]?.sell ?? null;
const setPrice = (set) => priceOf(`${set} Set`);
const relicPrice = (relic) => priceOf(`${relic} Relic`);
const marketUrl = (name) => (PRICES[name]?.slug ? `https://warframe.market/items/${PRICES[name].slug}` : null);
// Opens the item's warframe.market page in a new tab, where you place the sell order yourself.
const sellLink = (name) =>
  marketUrl(name)
    ? `<a class="sell-link" href="${esc(marketUrl(name))}" target="_blank" rel="noopener" title="Open ${esc(name)} on warframe.market to list it for sale">Sell ↗</a>`
    : '';

function toast(msg, undoable = false) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  if (undoable) {
    const b = document.createElement('button');
    b.className = 'small';
    b.textContent = 'Undo';
    b.addEventListener('click', () => {
      el.remove();
      undo();
    });
    el.append(' ', b);
  }
  document.body.append(el);
  setTimeout(() => el.remove(), undoable ? 7000 : 2400);
}

// ---- State -----------------------------------------------------------------

const emptyState = () => ({ v: 1, savedAt: 0, relics: {}, parts: {}, wishlist: [], mastered: {}, settings: { ducatRatio: 10 } });

// Accepts anything JSON shaped and returns a clean state, dropping unknown names and zero counts.
function sanitize(raw) {
  const s = emptyState();
  if (!raw || typeof raw !== 'object') return s;
  for (const [name, counts] of Object.entries(raw.relics ?? {})) {
    if (!DATA.relics[name] || !counts) continue;
    const c = {};
    for (const r of REFS) if (Number(counts[r]) > 0) c[r] = Math.floor(Number(counts[r]));
    if (Object.keys(c).length) s.relics[name] = c;
  }
  for (const [name, n] of Object.entries(raw.parts ?? {})) {
    if (DATA.parts[name] && Number(n) > 0) s.parts[name] = Math.floor(Number(n));
  }
  s.wishlist = [...new Set((Array.isArray(raw.wishlist) ? raw.wishlist : []).filter((n) => DATA.sets[n]))];
  for (const [id, v] of Object.entries(raw.mastered ?? {})) if (v) s.mastered[id] = true;
  const ratio = Number(raw.settings?.ducatRatio);
  if (ratio > 0) s.settings.ducatRatio = ratio;
  s.savedAt = Number(raw.savedAt) > 0 ? Number(raw.savedAt) : 0;
  return s;
}

function loadState() {
  try {
    return sanitize(JSON.parse(localStorage.getItem(STORE_KEY) || 'null'));
  } catch {
    return emptyState();
  }
}

function writeLocal() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    return true;
  } catch {
    toast('Could not save: browser storage is unavailable');
    return false;
  }
}

// Every change goes through here. savedAt lets sync tell which copy is newer.
function save(msg, undoable = false) {
  state = sanitize({ ...state, savedAt: Date.now() });
  if (!writeLocal()) return;
  if (msg) toast(msg, undoable);
  schedulePush();
}

// Undo: a copy of the vault is kept before each change that removes or overwrites something.
// It lives in memory only, so it covers this visit to the site.
const undoStack = [];
function checkpoint() {
  undoStack.push(JSON.stringify(state));
  if (undoStack.length > 20) undoStack.shift();
}
function undo() {
  const prev = undoStack.pop();
  if (!prev) return toast('Nothing to undo');
  state = sanitize(JSON.parse(prev));
  save('Undone');
  render();
}

// ---- Derived inventory -----------------------------------------------------

const relicTotal = (name) => sum(REFS.map((r) => state.relics[name]?.[r] ?? 0));
const bestRef = (name) => [...REFS].reverse().find((r) => state.relics[name]?.[r] > 0) ?? 'intact';
const owned = (part) => state.parts[part] ?? 0;

// Parts needed by the wishlist: part name -> total count across wishlist sets.
function needs() {
  const need = {};
  for (const set of state.wishlist) for (const p of DATA.sets[set]?.parts ?? []) need[p.name] = (need[p.name] ?? 0) + p.count;
  return need;
}
const missingOf = (need, part) => Math.max(0, (need[part] ?? 0) - owned(part));
const spareOf = (need, part) => Math.max(0, owned(part) - (need[part] ?? 0));

const setComplete = (set) => DATA.sets[set].parts.every((p) => owned(p.name) >= p.count);

// Expected value of opening one relic at a refinement, in plat and ducats.
function relicEV(name, ref) {
  let plat = 0;
  let ducats = 0;
  for (const w of DATA.relics[name].rewards) {
    const c = (w.chance[ref] ?? 0) / 100;
    plat += c * (priceOf(w.item) ?? 0);
    ducats += c * (DATA.parts[w.item]?.ducats ?? 0);
  }
  return { plat, ducats };
}

const masteryItems = () => DATA.mastery;
const masteryXp = (items) => sum(items.map((m) => m.xp));

// ---- Views -----------------------------------------------------------------

const VIEWS = {};
const ACTIONS = {}; // click handlers: data-action
const CHANGES = {}; // change handlers: data-change
const FORMS = {}; // submit handlers: data-form
const INPUTS = {}; // live input handlers: data-input (debounced)

const head = (title, text) => `<div class="head"><div><h2>${esc(title)}</h2>${text ? `<p>${text}</p>` : ''}</div></div>`;
const stat = (label, value, sub = '', extra = '') =>
  `<div class="stat"><div class="label">${esc(label)}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}${extra}</div>`;

VIEWS.overview = () => {
  const need = needs();
  const items = masteryItems();
  const done = items.filter((m) => state.mastered[m.id]);
  const totalXp = masteryXp(items);
  const doneXp = masteryXp(done);

  const setsDone = state.wishlist.filter(setComplete).length;
  const missingParts = sum(Object.keys(need).map((p) => missingOf(need, p)));

  const ownedRelics = Object.keys(state.relics);
  const usefulRelic = (r) => DATA.relics[r].rewards.filter((w) => missingOf(need, w.item) > 0).length;
  const relicCount = sum(ownedRelics.map(relicTotal));
  const useful = ownedRelics.filter((r) => usefulRelic(r) > 0);

  const spares = Object.keys(state.parts).map((p) => ({ p, n: spareOf(need, p) })).filter((x) => x.n > 0);
  const spareP = sum(spares.map(({ p, n }) => (priceOf(p) ?? 0) * n));
  const spareD = sum(spares.map(({ p, n }) => (DATA.parts[p]?.ducats ?? 0) * n));

  const topRelics = useful
    .map((r) => ({ r, n: usefulRelic(r) }))
    .sort((a, b) => b.n - a.n || relicTotal(b.r) - relicTotal(a.r));
  const noSource = Object.keys(need).filter(
    (p) => missingOf(need, p) > 0 && !(DATA.parts[p]?.relics ?? []).some((r) => relicTotal(r) > 0),
  );

  const empty = !ownedRelics.length && !Object.keys(state.parts).length && !state.wishlist.length && !done.length;
  return `
    ${head('Overview', 'Everything you entered by hand, at a glance. Nothing here ever touches the game.')}
    ${empty ? `<div class="note">Your vault is empty. Start in <a href="#mastery">Mastery</a> to tick off what you already have, add sets you want in <a href="#wishlist">Wishlist</a>, or paste a list of relics and parts in <a href="#data">Data</a>.</div>` : ''}
    <div class="grid stats">
      ${stat('Mastery', fmtNum(doneXp), `of ${fmtNum(totalXp)} points, ${fmtNum(totalXp - doneXp)} left`, bar(doneXp, totalXp))}
      ${stat('Items mastered', `${done.length}`, `of ${items.length} tracked items`, bar(done.length, items.length))}
      ${stat('Wishlist', `${setsDone} / ${state.wishlist.length}`, `sets ready to build, ${missingParts} parts missing`, bar(setsDone, state.wishlist.length))}
      ${stat('Relics', fmtNum(relicCount), `${ownedRelics.length} kinds, ${useful.length} with parts you still need`)}
      ${stat('Spare parts', fmtP(spareP), `${fmtD(spareD)} if traded to Baro`)}
    </div>
    <div class="panel" style="margin-top:14px">
      <h3>Next steps</h3>
      ${
        topRelics.length
          ? `<p class="muted small">Your relics with the most parts you still need. Crack these first. Click one to see what it drops, your wishlist parts are in blue.</p>
             ${showMore(
               topRelics.map(
                 ({ r, n }) => `<details class="expand">
                   <summary class="reward"><span><b>${esc(r)}</b> <span class="muted">${countsShort(r)}</span> ${relicBadge(r)}</span><span class="meta">${n} needed part${n > 1 ? 's' : ''}</span></summary>
                   <div class="rewards">${DATA.relics[r].rewards.map((w) => rewardLine(w, bestRef(r), need)).join('')}</div>
                   <div class="small muted">Chances for ${REF_LABEL[bestRef(r)].toLowerCase()}. <a href="#relics">Open Relics</a></div>
                 </details>`,
               ),
               5,
             )}`
          : `<p class="muted">No owned relic contains a part your wishlist still needs.</p>`
      }
      ${
        noSource.length
          ? `<p class="muted small" style="margin-top:14px">Needed parts you own no relic for. Click one to see where to farm or buy it.</p>
             ${showMore(
               noSource.map(
                 (p) => `<details class="expand">
                   <summary class="reward"><span>${esc(p)} <span class="muted small">${esc(partSets(p).join(', '))}</span></span><span class="meta">${DATA.parts[p]?.farmable ? '<span class="badge farm">Farmable</span>' : '<span class="badge vault">Vaulted</span>'}</span></summary>
                   <div class="where small">${whereToGet(p)}</div>
                 </details>`,
               ),
               8,
             )}`
          : ''
      }
    </div>`;
};

// A list that shows its first `first` items and reveals the rest in place, so open items stay open.
function showMore(items, first) {
  if (items.length <= first) return `<div class="rewards">${items.join('')}</div>`;
  return `<div class="rewards" data-more>
      ${items.map((it, i) => (i < first ? it : `<div class="extra">${it}</div>`)).join('')}
      <button class="small ghost" data-action="more" data-n="${items.length - first}">Show ${items.length - first} more</button>
    </div>`;
}
ACTIONS.more = (el) => {
  const box = el.closest('[data-more]');
  const all = box.classList.toggle('show-all');
  el.textContent = all ? 'Show fewer' : `Show ${el.dataset.n} more`;
};

// Long pages render a first batch and grow on demand, instead of drawing hundreds of rows at once.
// The count resets whenever that page's filters change (filters is any JSON-able value).
const PAGE_SIZE = { relics: 24, parts: 50, wishlist: 12, mastery: 60, trade: 50 };
const pages = {}; // key -> { sig, limit }
function page(key, items, filters = null) {
  const sig = JSON.stringify(filters);
  if (pages[key]?.sig !== sig) pages[key] = { sig, limit: PAGE_SIZE[key] };
  const { limit } = pages[key];
  const rest = items.length - limit;
  return {
    items: items.slice(0, limit),
    more:
      rest > 0
        ? `<div class="toolbar more-row">
             <button class="small" data-action="page-more" data-key="${key}">Show ${Math.min(rest, PAGE_SIZE[key])} more</button>
             <button class="small ghost" data-action="page-all" data-key="${key}">Show all ${items.length}</button>
             <span class="muted small">${limit} of ${items.length} shown</span>
           </div>`
        : '',
  };
}
ACTIONS['page-more'] = (el) => {
  pages[el.dataset.key].limit += PAGE_SIZE[el.dataset.key];
  render();
};
ACTIONS['page-all'] = (el) => {
  pages[el.dataset.key].limit = Infinity;
  render();
};

// ---- Relics ------------------------------------------------------------------

const relicIndex = () => (relicIndex.map ??= new Map(Object.keys(DATA.relics).map((k) => [norm(k), k])));
const resolveRelic = (text) => relicIndex().get(norm(text).replace(/\brelic\b/g, '').replace(/\s+/g, ' ').trim()) ?? null;

const ERA_ORDER = ['Lith', 'Meso', 'Neo', 'Axi', 'Requiem', 'Vanguard'];
const eraRank = (era) => (ERA_ORDER.includes(era) ? ERA_ORDER.indexOf(era) : ERA_ORDER.length);

const relicBadge = (name) =>
  DATA.relics[name].farmable ? '<span class="badge farm">Dropping now</span>' : '<span class="badge vault">Vaulted</span>';

function rewardLine(w, ref, need) {
  const part = DATA.parts[w.item];
  const want = missingOf(need, w.item) > 0;
  const meta = [fmtPct(w.chance[ref]), priceOf(w.item) != null ? fmtP(priceOf(w.item)) : '', part?.ducats ? fmtD(part.ducats) : '']
    .filter(Boolean)
    .join(' · ');
  return `<div class="reward ${w.rarity}${want ? ' want' : ''}"><span class="name">${esc(w.item)}</span><span class="meta">${meta}</span></div>`;
}

function relicCard(name, need) {
  const relic = DATA.relics[name];
  const ref = bestRef(name);
  const ev = { intact: relicEV(name, 'intact'), radiant: relicEV(name, 'radiant') };
  const price = relicPrice(name);
  return `
    <article class="card">
      <header>
        <div><h3>${esc(name)}</h3><div class="row small muted">${esc(relic.era)} ${relicBadge(name)}${price != null ? ` <span>${fmtP(price)} intact</span>` : ''}</div></div>
        <button class="small ghost danger" data-action="relic-remove" data-relic="${esc(name)}" title="Remove">✕</button>
      </header>
      <div class="counts">
        ${REFS.map(
          (r) => `<label>${REF_LABEL[r]}<input type="number" min="0" step="1" value="${state.relics[name]?.[r] ?? 0}"
            data-change="relic-count" data-relic="${esc(name)}" data-ref="${r}" data-focus="relic:${esc(name)}:${r}"></label>`,
        ).join('')}
      </div>
      <div class="rewards">${relic.rewards.map((w) => rewardLine(w, ref, need)).join('')}</div>
      <div class="ev">
        <span>EV intact <b>${fmtP(ev.intact.plat, 1)}</b> / ${fmtD(ev.intact.ducats, 1)}</span>
        <span>EV radiant <b>${fmtP(ev.radiant.plat, 1)}</b> / ${fmtD(ev.radiant.ducats, 1)}</span>
      </div>
      <div class="small muted">Chances shown for ${REF_LABEL[ref].toLowerCase()}.</div>
    </article>`;
}

// Owned relics passing the Relics tab filters, unsorted.
function relicsShown(need = needs()) {
  const f = (ui.relics ??= { q: '', filter: 'all', era: '', sort: 'ev' });
  const q = norm(f.q);
  const hasWanted = (r) => DATA.relics[r].rewards.some((w) => missingOf(need, w.item) > 0);
  let names = Object.keys(state.relics);
  if (f.filter === 'wanted') names = names.filter(hasWanted);
  if (f.filter === 'vaulted') names = names.filter((r) => !DATA.relics[r].farmable);
  if (f.era && !Object.keys(state.relics).some((r) => DATA.relics[r].era === f.era)) f.era = '';
  if (f.era) names = names.filter((r) => DATA.relics[r].era === f.era);
  // Search matches the relic's name or anything it drops ("loki" finds relics with Loki Prime parts).
  if (q) names = names.filter((r) => norm(r).includes(q) || DATA.relics[r].rewards.some((w) => norm(w.item).includes(q)));
  return names;
}

VIEWS.relics = () => {
  const need = needs();
  const names = relicsShown(need);
  const f = ui.relics;
  const evOf = (r) => relicEV(r, bestRef(r)).plat;
  const sorters = {
    ev: (a, b) => evOf(b) - evOf(a),
    name: (a, b) => eraRank(DATA.relics[a].era) - eraRank(DATA.relics[b].era) || a.localeCompare(b, 'en', { numeric: true }),
    count: (a, b) => relicTotal(b) - relicTotal(a),
  };
  names.sort(sorters[f.sort] ?? sorters.ev);
  const total = Object.keys(state.relics).length;
  const eras = [...new Set(Object.keys(state.relics).map((r) => DATA.relics[r].era))].sort((a, b) => eraRank(a) - eraRank(b));
  const eraCount = (era) => sum(Object.keys(state.relics).filter((r) => DATA.relics[r].era === era).map(relicTotal));

  return `
    ${head('Relics', 'Every relic you own, by refinement. Parts your wishlist still needs are highlighted in blue. EV is the average platinum and ducats one opening is worth at market prices.')}
    <form class="toolbar" data-form="relic-add">
      <input class="grow" name="name" list="dl-relics" placeholder="Relic, e.g. Neo H4" autocomplete="off" data-focus="relic-add" required>
      <select name="ref">${REFS.map((r) => `<option value="${r}">${REF_LABEL[r]}</option>`).join('')}</select>
      <input type="number" name="qty" min="1" value="1" aria-label="Quantity">
      <button class="primary">Add</button>
    </form>
    <div class="toolbar">
      <input class="grow" type="search" placeholder="Search relics or what they drop" value="${esc(f.q ?? '')}" data-input="relic-q" data-focus="relic-q">
      <select data-change="relic-filter" aria-label="Filter">
        ${[['all', 'All relics'], ['wanted', 'Has parts I need'], ['vaulted', 'Vaulted only']].map(([v, l]) => `<option value="${v}"${f.filter === v ? ' selected' : ''}>${l}</option>`).join('')}
      </select>
      <select data-change="relic-era" aria-label="Relic type">
        <option value="">All types</option>
        ${eras.map((e) => `<option value="${esc(e)}"${f.era === e ? ' selected' : ''}>${esc(e)} (${eraCount(e)})</option>`).join('')}
      </select>
      <select data-change="relic-sort" aria-label="Sort">
        ${[['ev', 'Sort by EV'], ['name', 'Sort by name'], ['count', 'Sort by count']].map(([v, l]) => `<option value="${v}"${f.sort === v ? ' selected' : ''}>${l}</option>`).join('')}
      </select>
      <span class="spacer"></span>
      <span class="muted small">${names.length} of ${total} relics shown</span>
      ${names.length ? `<button class="small danger" data-action="relics-remove-shown">${names.length === total ? `Remove all ${total}` : `Remove these ${names.length}`}</button>` : ''}
    </div>
    ${
      names.length
        ? ((pg) => `<div class="grid cards">${pg.items.map((r) => relicCard(r, need)).join('')}</div>${pg.more}`)(page('relics', names, f))
        : `<div class="empty">${total ? 'No relic matches this filter.' : 'No relics yet. Add one above or bulk paste a list in Data.'}</div>`
    }
    <p class="small muted" style="margin-top:14px">“Vaulted” means the relic is not in any mission or bounty drop table today. Relics from Prime Resurgence (Varzia) also show as vaulted.</p>`;
};

FORMS['relic-add'] = (form, fd) => {
  const name = resolveRelic(fd.get('name'));
  if (!name) return toast(`Unknown relic “${fd.get('name')}”`);
  const ref = fd.get('ref');
  const qty = Math.max(1, Number(fd.get('qty')) || 1);
  const r = (state.relics[name] ??= {});
  r[ref] = (r[ref] ?? 0) + qty;
  save(`Added ${qty}× ${name} ${REF_LABEL[ref]}`);
  render();
};
CHANGES['relic-count'] = (el) => {
  checkpoint();
  const r = (state.relics[el.dataset.relic] ??= {});
  r[el.dataset.ref] = Math.max(0, Math.floor(Number(el.value) || 0));
  if (relicTotal(el.dataset.relic)) save();
  else save(`Removed ${el.dataset.relic}`, true);
  render();
};
INPUTS['relic-q'] = (el) => {
  ui.relics.q = el.value;
  render();
};
ACTIONS['relics-remove-shown'] = () => {
  const names = relicsShown();
  const f = ui.relics;
  const what = f.q || f.era || f.filter !== 'all' ? `the ${names.length} relics matching your filters` : `all ${names.length} relics`;
  if (!names.length || !confirm(`Remove ${what} from your vault? You can undo this.`)) return;
  checkpoint();
  for (const r of names) delete state.relics[r];
  save(`Removed ${names.length} relics`, true);
  render();
};
CHANGES['relic-filter'] = (el) => {
  ui.relics.filter = el.value;
  render();
};
CHANGES['relic-era'] = (el) => {
  ui.relics.era = el.value;
  render();
};
CHANGES['relic-sort'] = (el) => {
  ui.relics.sort = el.value;
  render();
};
ACTIONS['relic-remove'] = (el) => {
  checkpoint();
  delete state.relics[el.dataset.relic];
  save(`Removed ${el.dataset.relic}`, true);
  render();
};

// ---- Prime parts -------------------------------------------------------------

const partIndex = () => (partIndex.map ??= new Map(Object.keys(DATA.parts).map((k) => [norm(k), k])));

// Case insensitive, accepts a missing trailing "Blueprint" and a unique prefix.
function resolvePart(text) {
  const t = norm(text);
  if (!t) return null;
  const idx = partIndex();
  if (idx.has(t)) return idx.get(t);
  if (idx.has(`${t} blueprint`)) return idx.get(`${t} blueprint`);
  const hits = [...idx.keys()].filter((k) => k.startsWith(`${t} `) || k.startsWith(t));
  return hits.length === 1 ? idx.get(hits[0]) : null;
}

const partSets = (p) => DATA.parts[p]?.sets ?? [];
const partSortKey = (p) => `${partSets(p)[0] ?? '~'}|${p}`;

// A part's type is the category of its set (Warframe, Primary, Melee...).
const partType = (p) => DATA.sets[partSets(p)[0]]?.category ?? 'Other';
function partsShown() {
  const f = (ui.parts ??= { q: '', type: '' });
  const q = norm(f.q);
  const all = Object.keys(state.parts);
  if (f.type && !all.some((p) => partType(p) === f.type)) f.type = '';
  return all
    .filter((p) => (!f.type || partType(p) === f.type) && (!q || norm(p).includes(q) || partSets(p).some((s) => norm(s).includes(q)))).sort((a, b) => partSortKey(a).localeCompare(partSortKey(b)));
}

VIEWS.parts = () => {
  const need = needs();
  const names = partsShown();
  const f = ui.parts;
  const types = [...new Set(Object.keys(state.parts).map(partType))].sort();
  const total = Object.keys(state.parts).length;
  const buildable = Object.keys(DATA.sets).filter(setComplete);
  const pg = page('parts', names, f);
  const rows = pg.items.map((p) => {
    const n = need[p] ?? 0;
    const status = n ? (owned(p) >= n ? '<span class="ok">✓</span>' : `<span class="miss">${missingOf(need, p)} short</span>`) : '';
    return `<tr>
      <td>${esc(p)}</td>
      <td class="muted">${partSets(p).map(esc).join(', ') || '–'}</td>
      <td class="num"><input type="number" min="0" value="${owned(p)}" data-change="part-count" data-part="${esc(p)}" data-focus="part:${esc(p)}" aria-label="Owned"></td>
      <td class="num">${n || ''} ${status}</td>
      <td class="num">${fmtD(DATA.parts[p].ducats)}</td>
      <td class="num">${fmtP(priceOf(p))}</td>
      <td>${sellLink(p)}</td>
    </tr>`;
  });
  return `
    ${head('Prime parts', 'Parts sitting in your inventory. Names match the game, so “Loki Prime Chassis” finds “Loki Prime Chassis Blueprint”. Set an amount to 0 to remove it.')}
    <form class="toolbar" data-form="part-add">
      <input class="grow" name="name" list="dl-parts" placeholder="Part, e.g. Loki Prime Chassis Blueprint" autocomplete="off" data-focus="part-add" required>
      <input type="number" name="qty" min="1" value="1" aria-label="Quantity">
      <button class="primary">Add</button>
    </form>
    ${
      total
        ? `<div class="toolbar">
             <input class="grow" type="search" placeholder="Search your parts or sets" value="${esc(f.q ?? '')}" data-input="parts-q" data-focus="parts-q">
             <select data-change="parts-type" aria-label="Type"><option value="">All types</option>${types
               .map((t) => `<option value="${esc(t)}"${f.type === t ? ' selected' : ''}>${esc(t)} (${Object.keys(state.parts).filter((p) => partType(p) === t).length})</option>`)
               .join('')}</select>
             <span class="spacer"></span>
             <span class="muted small">${names.length} of ${total} kinds shown</span>
             <button class="small danger" data-action="parts-remove-shown">${names.length === total ? `Remove all ${total}` : `Remove these ${names.length}`}</button>
           </div>`
        : ''
    }
    ${
      buildable.length
        ? `<div class="panel" style="margin-bottom:14px"><h3>You can build right now</h3>
           <div class="row" style="margin-top:8px">${buildable
             .map((s) => `<span class="badge gold">${esc(s)}${state.mastered[DATA.sets[s].id] ? ' · mastered' : ''}</span>`)
             .join('')}</div></div>`
        : ''
    }
    ${
      names.length
        ? `<div class="table-wrap"><table>
             <thead><tr><th>Part</th><th>Set</th><th class="num">Owned</th><th class="num">Needed</th><th class="num">Ducats</th><th class="num">Price</th><th></th></tr></thead>
             <tbody>${rows.join('')}</tbody>
           </table></div>
           ${pg.more}
           <p class="small muted">${names.length} kinds, ${sum(names.map(owned))} parts in total.</p>`
        : '<div class="empty">No prime parts yet. Add one above or bulk paste a list in Data.</div>'
    }`;
};

FORMS['part-add'] = (form, fd) => {
  const name = resolvePart(fd.get('name'));
  if (!name) return toast(`Unknown or ambiguous part “${fd.get('name')}”`);
  const qty = Math.max(1, Number(fd.get('qty')) || 1);
  state.parts[name] = owned(name) + qty;
  save(`Added ${qty}× ${name}`);
  render();
};
CHANGES['part-count'] = (el) => {
  checkpoint();
  state.parts[el.dataset.part] = Math.max(0, Math.floor(Number(el.value) || 0));
  if (state.parts[el.dataset.part]) save();
  else save(`Removed ${el.dataset.part}`, true);
  render();
};
INPUTS['parts-q'] = (el) => {
  ui.parts.q = el.value;
  render();
};
CHANGES['parts-type'] = (el) => {
  ui.parts.type = el.value;
  render();
};
ACTIONS['parts-remove-shown'] = () => {
  const names = partsShown();
  const what = ui.parts.q || ui.parts.type ? `the ${names.length} part kinds matching your filters` : `all ${names.length} part kinds`;
  if (!names.length || !confirm(`Remove ${what} from your vault? You can undo this.`)) return;
  checkpoint();
  for (const p of names) delete state.parts[p];
  save(`Removed ${names.length} part kinds`, true);
  render();
};

// ---- Wishlist ------------------------------------------------------------------

const setIndex = () => (setIndex.map ??= new Map(Object.keys(DATA.sets).map((k) => [norm(k), k])));
const resolveSet = (text) => setIndex().get(norm(text).replace(/ set$/, '')) ?? null;

const chanceIn = (relic, part, ref) => DATA.relics[relic]?.rewards.find((w) => w.item === part)?.chance[ref] ?? null;
const refShort = { intact: 'I', exceptional: 'E', flawless: 'F', radiant: 'R' };
const countsShort = (relic) =>
  REFS.filter((r) => state.relics[relic]?.[r] > 0).map((r) => `${state.relics[relic][r]}${refShort[r]}`).join(' ');

function whereToGet(part) {
  const info = DATA.parts[part];
  const relics = info?.relics ?? [];
  const lines = [];
  const mine = relics.filter((r) => relicTotal(r) > 0);
  if (mine.length) {
    lines.push(`In your relics: ${mine
      .map((r) => `<b>${esc(r)}</b> (${countsShort(r)}, ${fmtPct(chanceIn(r, part, bestRef(r)))})`)
      .join(', ')}`);
  }
  const farm = relics.filter((r) => DATA.relics[r].farmable).sort((a, b) => chanceIn(b, part, 'intact') - chanceIn(a, part, 'intact'));
  if (farm.length) {
    lines.push(`Farm: ${farm
      .map((r) => `<b>${esc(r)}</b> ${fmtPct(chanceIn(r, part, 'intact'))} → ${fmtPct(chanceIn(r, part, 'radiant'))} rad`)
      .join(', ')}`);
  } else {
    const price = priceOf(part);
    const url = marketUrl(part);
    const buy = price != null ? `Buy on ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">warframe.market</a>` : 'warframe.market'} for ~${fmtP(price)}` : `Buy it on ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">warframe.market</a>` : 'warframe.market'}`;
    lines.push(`<span class="badge vault">Vaulted</span> ${buy}, or wait for its relics in Prime Resurgence (Varzia).`);
  }
  return lines.map((l) => `<div>${l}</div>`).join('');
}

function wishCard(set, need) {
  const s = DATA.sets[set];
  const have = sum(s.parts.map((p) => Math.min(owned(p.name), p.count)));
  const total = sum(s.parts.map((p) => p.count));
  const price = setPrice(set);
  const url = marketUrl(`${set} Set`);
  const lines = s.parts.map((p) => {
    const o = owned(p.name);
    // When several wishlist sets share a part, each card shows this set's own count against what you own.
    const ok = o >= (need[p.name] ?? p.count);
    return `<div class="part-line">
      <span>${esc(p.name)}</span>
      <span class="${ok ? 'ok' : 'miss'}">${o} / ${p.count}${(need[p.name] ?? 0) > p.count ? ` <span class="muted small">(${need[p.name]} for all sets)</span>` : ''}</span>
      ${ok ? '' : `<div class="where">${whereToGet(p.name)}</div>`}
    </div>`;
  });
  return `
    <article class="card">
      <header>
        <div>
          <h3>${esc(set)}</h3>
          <div class="row small muted">${esc(s.category)} ${s.vaulted ? '<span class="badge vault">Vaulted</span>' : ''}
            ${price != null ? `<span>Set ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${fmtP(price)}</a>` : fmtP(price)}</span>` : ''}
            ${state.mastered[s.id] ? '<span class="badge gold">Mastered</span>' : ''}</div>
        </div>
        <button class="small ghost danger" data-action="wish-remove" data-set="${esc(set)}" title="Remove from wishlist">✕</button>
      </header>
      ${bar(have, total)}
      <div class="small muted" style="margin-top:4px">${have} of ${total} parts</div>
      <div style="margin-top:8px">${lines.join('')}</div>
      <div class="row" style="margin-top:10px">
        <span class="spacer"></span>
        <button class="small${have === total ? ' primary' : ''}" data-action="wish-built" data-set="${esc(set)}">Mark as built</button>
      </div>
    </article>`;
}

// Parts of a set still missing, against this set's own counts.
const setMissing = (set) => DATA.sets[set].parts.filter((p) => owned(p.name) < p.count);
const setProgress = (set) => {
  const parts = DATA.sets[set].parts;
  const total = sum(parts.map((p) => p.count));
  return total ? sum(parts.map((p) => Math.min(owned(p.name), p.count))) / total : 0;
};

VIEWS.wishlist = () => {
  const need = needs();
  const f = (ui.wish ??= { q: '', category: '', status: '', source: '', sort: 'name' });
  const q = norm(f.q);
  const inMyRelics = (set) => setMissing(set).some((p) => (DATA.parts[p.name]?.relics ?? []).some((r) => relicTotal(r) > 0));
  const sources = {
    open: (set) => !DATA.sets[set].vaulted,
    vaulted: (set) => DATA.sets[set].vaulted,
    mine: inMyRelics,
  };
  const sets = state.wishlist.filter(
    (set) =>
      (!q || norm(set).includes(q)) &&
      (!f.category || DATA.sets[set].category === f.category) &&
      (!f.status || (f.status === 'ready') === setComplete(set)) &&
      (!f.source || sources[f.source](set)),
  );
  const sorters = {
    name: (a, b) => a.localeCompare(b),
    progress: (a, b) => setProgress(b) - setProgress(a) || a.localeCompare(b),
    missing: (a, b) => setMissing(a).length - setMissing(b).length || a.localeCompare(b),
    price: (a, b) => (setPrice(b) ?? -1) - (setPrice(a) ?? -1) || a.localeCompare(b),
  };
  sets.sort(sorters[f.sort] ?? sorters.name);
  const categories = [...new Set(state.wishlist.map((s) => DATA.sets[s].category))].sort();
  const opt = (v, l, cur) => `<option value="${esc(v)}"${cur === v ? ' selected' : ''}>${esc(l)}</option>`;
  return `
    ${head('Wishlist', 'Prime sets you want to build. Missing parts show which of your relics can drop them, which relics you can farm today, or where to buy them if everything is vaulted.')}
    <form class="toolbar" data-form="wish-add">
      <input class="grow" name="name" list="dl-sets" placeholder="Set, e.g. Loki Prime" autocomplete="off" data-focus="wish-add" required>
      <button class="primary">Add</button>
    </form>
    ${
      state.wishlist.length
        ? `<div class="toolbar">
             <input class="grow" type="search" placeholder="Search your wishlist" value="${esc(f.q)}" data-input="wish-q" data-focus="wish-q">
             <select data-change="wish-filter" data-key="category" aria-label="Category">${opt('', 'All categories', f.category)}${categories.map((c) => opt(c, c, f.category)).join('')}</select>
             <select data-change="wish-filter" data-key="status" aria-label="Status">${opt('', 'Any progress', f.status)}${opt('ready', 'Ready to build', f.status)}${opt('missing', 'Missing parts', f.status)}</select>
             <select data-change="wish-filter" data-key="source" aria-label="Source">${opt('', 'Any source', f.source)}${opt('open', 'Not vaulted', f.source)}${opt('vaulted', 'Vaulted', f.source)}${opt('mine', 'Missing parts in my relics', f.source)}</select>
             <select data-change="wish-filter" data-key="sort" aria-label="Sort">${opt('name', 'Sort by name', f.sort)}${opt('progress', 'Closest to done', f.sort)}${opt('missing', 'Fewest missing parts', f.sort)}${opt('price', 'Set price', f.sort)}</select>
             <span class="muted small">${sets.length} of ${state.wishlist.length} sets shown</span>
             ${sets.length ? `<button class="small danger" data-action="wish-remove-shown" data-sets="${esc(JSON.stringify(sets))}">${sets.length === state.wishlist.length ? `Remove all ${sets.length}` : `Remove these ${sets.length}`}</button>` : ''}
           </div>`
        : ''
    }
    ${
      sets.length
        ? ((pg) => `<div class="grid cards">${pg.items.map((s) => wishCard(s, need)).join('')}</div>${pg.more}`)(page('wishlist', sets, f))
        : state.wishlist.length
          ? '<div class="empty">No set on your wishlist matches these filters.</div>'
          : '<div class="empty">Your wishlist is empty. Add a set above, or use “Add to wishlist” on an unmastered prime in Mastery.</div>'
    }`;
};

INPUTS['wish-q'] = (el) => {
  ui.wish.q = el.value;
  render();
};
CHANGES['wish-filter'] = (el) => {
  ui.wish[el.dataset.key] = el.value;
  render();
};

function addToWishlist(set) {
  if (state.wishlist.includes(set)) return toast(`${set} is already on your wishlist`);
  state.wishlist.push(set);
  save(`Added ${set} to your wishlist`);
  render();
}

FORMS['wish-add'] = (form, fd) => {
  const set = resolveSet(fd.get('name'));
  if (!set) return toast(`Unknown prime set “${fd.get('name')}”`);
  addToWishlist(set);
};
ACTIONS['wish-add'] = (el) => addToWishlist(el.dataset.set);
ACTIONS['wish-remove'] = (el) => {
  checkpoint();
  state.wishlist = state.wishlist.filter((s) => s !== el.dataset.set);
  save(`Removed ${el.dataset.set} from your wishlist`, true);
  render();
};
ACTIONS['wish-remove-shown'] = (el) => {
  const sets = JSON.parse(el.dataset.sets);
  if (!confirm(`Remove ${sets.length} set${sets.length === 1 ? '' : 's'} from your wishlist? You can undo this.`)) return;
  checkpoint();
  state.wishlist = state.wishlist.filter((s) => !sets.includes(s));
  save(`Removed ${sets.length} sets from your wishlist`, true);
  render();
};
ACTIONS['wish-built'] = (el) => {
  const set = el.dataset.set;
  const s = DATA.sets[set];
  if (!confirm(`Mark ${set} as built? Its parts you own are removed from your inventory and it is marked as mastered.`)) return;
  checkpoint();
  for (const p of s.parts) state.parts[p.name] = Math.max(0, owned(p.name) - p.count);
  state.wishlist = state.wishlist.filter((x) => x !== set);
  state.mastered[s.id] = true;
  save(`${set} built and marked as mastered`, true);
  render();
};

// ---- Mastery -------------------------------------------------------------------

function masteryShown() {
  const f = (ui.mastery ??= { q: '', category: '', prime: '', status: 'todo' });
  const q = norm(f.q);
  return masteryItems().filter(
    (m) =>
      (!q || norm(m.name).includes(q)) &&
      (!f.category || m.category === f.category) &&
      (!f.prime || (f.prime === 'prime') === m.prime) &&
      (!f.status || (f.status === 'done') === Boolean(state.mastered[m.id])),
  );
}

VIEWS.mastery = () => {
  const items = masteryItems();
  const done = items.filter((m) => state.mastered[m.id]);
  const shown = masteryShown();
  const f = ui.mastery;
  const categories = [...new Set(items.map((m) => m.category))].sort();
  const opt = (v, l, cur) => `<option value="${esc(v)}"${cur === v ? ' selected' : ''}>${esc(l)}</option>`;
  const pg = page('mastery', shown, f);
  const rows = pg.items.map((m) => {
    const isDone = Boolean(state.mastered[m.id]);
    const wishable = m.prime && !isDone && DATA.sets[m.name] && !state.wishlist.includes(m.name);
    return `<tr class="${isDone ? 'dim' : ''}">
      <td><input type="checkbox" ${isDone ? 'checked' : ''} data-change="mastery-toggle" data-id="${esc(m.id)}" aria-label="Mastered"></td>
      <td>${esc(m.name)} ${m.prime && m.vaulted ? '<span class="badge vault">Vaulted</span>' : ''} ${state.wishlist.includes(m.name) ? '<span class="badge void">Wishlist</span>' : ''}</td>
      <td class="muted">${esc(m.category)}</td>
      <td class="muted hide-sm">${esc(m.type)}</td>
      <td class="num">${fmtNum(m.xp)}</td>
      <td class="num">${m.mr || ''}</td>
      <td>${wishable ? `<button class="small" data-action="wish-add" data-set="${esc(m.name)}">+ Wishlist</button>` : ''}</td>
    </tr>`;
  });
  return `
    ${head('Mastery', 'Every masterable item we know of. Tick what you have mastered. For a fast first fill, filter down to a category and use “Mark all as mastered” (it covers every match, not only the rows on screen), or import screenshots of Profile → Equipment in <a href="#data">Data</a>.')}
    <div class="panel" style="margin-bottom:14px">
      <div class="row"><b>${fmtNum(masteryXp(done))}</b> <span class="muted">of ${fmtNum(masteryXp(items))} mastery points ·</span>
        <b>${done.length}</b> <span class="muted">of ${items.length} items</span></div>
      ${bar(masteryXp(done), masteryXp(items))}
    </div>
    <div class="toolbar">
      <input class="grow" type="search" placeholder="Search" value="${esc(f.q)}" data-input="mastery-q" data-focus="mastery-q">
      <select data-change="mastery-filter" data-key="category" aria-label="Category">${opt('', 'All categories', f.category)}${categories.map((c) => opt(c, c, f.category)).join('')}</select>
      <select data-change="mastery-filter" data-key="prime" aria-label="Prime">${opt('', 'Prime and non prime', f.prime)}${opt('prime', 'Prime only', f.prime)}${opt('normal', 'Non prime only', f.prime)}</select>
      <select data-change="mastery-filter" data-key="status" aria-label="Status">${opt('todo', 'Not mastered', f.status)}${opt('done', 'Mastered', f.status)}${opt('', 'Any status', f.status)}</select>
    </div>
    <div class="toolbar">
      <span class="muted small">${shown.length} match, ${fmtNum(masteryXp(shown.filter((m) => !state.mastered[m.id])))} points still to earn among them</span>
      <span class="spacer"></span>
      <button class="small" data-action="mastery-bulk" data-value="1" ${shown.length ? '' : 'disabled'}>Mark all ${shown.length} as mastered</button>
      <button class="small danger" data-action="mastery-bulk" data-value="0" ${shown.length ? '' : 'disabled'}>Unmark all ${shown.length}</button>
    </div>
    ${
      shown.length
        ? `<div class="table-wrap"><table>
             <thead><tr><th></th><th>Name</th><th>Category</th><th class="hide-sm">Type</th><th class="num">XP</th><th class="num">MR</th><th></th></tr></thead>
             <tbody>${rows.join('')}</tbody>
           </table></div>
           ${pg.more}`
        : '<div class="empty">Nothing matches these filters.</div>'
    }
    <p class="small muted">Not tracked yet: Amps, some MOA and Hound parts, Plexus, intrinsics and the star chart.</p>`;
};

INPUTS['mastery-q'] = (el) => {
  ui.mastery.q = el.value;
  render();
};
CHANGES['mastery-filter'] = (el) => {
  ui.mastery[el.dataset.key] = el.value;
  render();
};
CHANGES['mastery-toggle'] = (el) => {
  checkpoint();
  if (el.checked) state.mastered[el.dataset.id] = true;
  else delete state.mastered[el.dataset.id];
  save();
  render();
};
ACTIONS['mastery-bulk'] = (el) => {
  const shown = masteryShown();
  const on = el.dataset.value === '1';
  if (!confirm(`${on ? 'Mark' : 'Unmark'} all ${shown.length} items matching your filters as ${on ? '' : 'not '}mastered? This includes the ones not on screen yet.`)) return;
  checkpoint();
  for (const m of shown) {
    if (on) state.mastered[m.id] = true;
    else delete state.mastered[m.id];
  }
  save(`${shown.length} items ${on ? 'marked' : 'unmarked'}`, true);
  render();
};

// ---- Sell or ducat ---------------------------------------------------------------

function verdictFor(part) {
  const price = priceOf(part);
  const ducats = DATA.parts[part]?.ducats ?? 0;
  if (price == null || price <= 0) return { key: 'hold', label: 'Hold', ratio: null };
  const ratio = ducats / price;
  return ratio >= state.settings.ducatRatio ? { key: 'ducat', label: 'Ducats', ratio } : { key: 'sell', label: 'Sell', ratio };
}

// Complete sets you could assemble from spare parts alone, where the set sells for more than its parts.
function spareSets(need) {
  const out = [];
  for (const [set, s] of Object.entries(DATA.sets)) {
    const k = Math.min(...s.parts.map((p) => Math.floor(spareOf(need, p.name) / p.count)));
    if (!(k >= 1)) continue;
    const setP = setPrice(set);
    const partsP = s.parts.every((p) => priceOf(p.name) != null) ? sum(s.parts.map((p) => priceOf(p.name) * p.count)) : null;
    if (setP != null && partsP != null && setP > partsP) out.push({ set, k, setP, partsP });
  }
  return out.sort((a, b) => b.setP - b.partsP - (a.setP - a.partsP));
}

VIEWS.trade = () => {
  const need = needs();
  const rows = Object.keys(state.parts)
    .map((p) => ({ p, n: spareOf(need, p), price: priceOf(p), buy: priceEntry(p)?.buy ?? null, ducats: DATA.parts[p]?.ducats ?? 0, v: verdictFor(p) }))
    .filter((r) => r.n > 0);
  const order = { sell: 0, ducat: 1, hold: 2 };
  rows.sort((a, b) => order[a.v.key] - order[b.v.key] || (b.price ?? 0) * b.n - (a.price ?? 0) * a.n || a.p.localeCompare(b.p));
  const sellPile = rows.filter((r) => r.v.key === 'sell');
  const ducatPile = rows.filter((r) => r.v.key === 'ducat');
  const sets = spareSets(need);
  const pg = page('trade', rows);

  return `
    ${head('Sell or ducat', 'Spare parts are the ones you own beyond what your wishlist needs. Prices are the median of the five cheapest sellers online on warframe.market, refreshed daily.')}
    <div class="panel" style="margin-bottom:14px">
      <label class="row">Trade for ducats when one plat is worth at least
        <input type="number" min="1" step="1" value="${state.settings.ducatRatio}" data-change="ratio" data-focus="ratio" aria-label="Ducats per plat"> ducats</label>
      <p class="small muted" style="margin:6px 0 0">A part that sells for 5p and gives 100 ducats returns 20 ducats per plat, so it goes to Baro at a threshold of 10. Lower the number to send more to Baro.</p>
    </div>
    ${
      rows.length
        ? `<div class="table-wrap"><table>
            <thead><tr><th>Part</th><th class="num">Spare</th><th class="num">Price</th><th class="num">Best buy</th><th class="num">Ducats</th><th class="num">D / p</th><th>Verdict</th><th class="num">Stack</th><th></th></tr></thead>
            <tbody>${pg.items
              .map(
                (r) => `<tr>
                  <td>${marketUrl(r.p) ? `<a href="${esc(marketUrl(r.p))}" target="_blank" rel="noopener">${esc(r.p)}</a>` : esc(r.p)}${priceEntry(r.p)?.stale ? ' <span class="badge" title="Last refresh failed, showing an older price">old</span>' : ''}</td>
                  <td class="num">${r.n}</td>
                  <td class="num">${fmtP(r.price)}</td>
                  <td class="num">${fmtP(r.buy)}</td>
                  <td class="num">${fmtD(r.ducats)}</td>
                  <td class="num">${r.v.ratio == null ? '–' : fmtNum(r.v.ratio, 1)}</td>
                  <td><span class="verdict ${r.v.key}">${r.v.label}</span></td>
                  <td class="num">${r.v.key === 'ducat' ? fmtD(r.ducats * r.n) : fmtP(r.price == null ? null : r.price * r.n)}</td>
                  <td>${sellLink(r.p)}</td>
                </tr>`,
              )
              .join('')}</tbody>
          </table></div>
          ${pg.more}
          <div class="grid stats" style="margin-top:14px">
            ${stat('Sell pile', fmtP(sum(sellPile.map((r) => r.price * r.n))), `${sum(sellPile.map((r) => r.n))} parts`)}
            ${stat('Ducat pile', fmtD(sum(ducatPile.map((r) => r.ducats * r.n))), `${sum(ducatPile.map((r) => r.n))} parts for Baro Ki'Teer`)}
          </div>`
        : '<div class="empty">No spare parts. Everything you own is needed by your wishlist, or you have not added parts yet.</div>'
    }
    ${
      sets.length
        ? `<div class="panel" style="margin-top:14px"><h3>Sell these as full sets</h3>
            <p class="small muted">Your spare parts complete these sets, and the set sells for more than the parts one by one.</p>
            <div class="rewards">${sets
              .map((s) => `<div class="reward"><span><b>${esc(s.set)}</b>${s.k > 1 ? ` ×${s.k}` : ''}</span><span class="meta">set ${fmtP(s.setP)} vs parts ${fmtP(s.partsP)} (+${fmtP(s.setP - s.partsP)})</span></div>`)
              .join('')}</div></div>`
        : ''
    }`;
};

CHANGES.ratio = (el) => {
  const v = Number(el.value);
  if (v > 0) state.settings.ducatRatio = v;
  save('Threshold saved');
  render();
};

// ---- Data: backup, import and bulk paste ---------------------------------------

// Reads "3x Neo H4", "Neo H4 Relic (Radiant) x3", "Ash Prime Systems x2" and so on.
// Returns candidate readings, most likely first: with a quantity split off, then the whole line as a name
// (so a relic like "Lith X1" is not mistaken for "Lith" times 1).
function quantityReadings(line) {
  const s = line.replace(/[()[\],]/g, ' ').replace(/\s+/g, ' ').trim();
  const out = [];
  let m;
  if ((m = s.match(/^(\d+)\s*x?\s+(.+)$/i))) out.push({ qty: Number(m[1]), rest: m[2] });
  else if ((m = s.match(/^(.+?)\s+(?:x\s*(\d+)|(\d+)\s*x)$/i))) out.push({ qty: Number(m[2] || m[3]), rest: m[1] });
  out.push({ qty: 1, rest: s });
  return out;
}

function matchInventoryLine(line) {
  for (const { qty, rest } of quantityReadings(line)) {
    if (qty < 1) continue;
    const refMatch = norm(rest).match(new RegExp(`\\b(${REFS.join('|')})\\b`));
    const ref = refMatch?.[1] ?? 'intact';
    const relic = resolveRelic(norm(rest).replace(refMatch?.[0] ?? '\u0000', ''));
    if (relic) return { kind: 'relic', name: relic, ref, qty };
    const part = resolvePart(rest);
    if (part) return { kind: 'part', name: part, qty };
  }
  return null;
}

function matchMasteryLine(line) {
  const t = norm(line);
  if (!t) return [];
  const exact = masteryItems().filter((m) => norm(m.name) === t);
  if (exact.length) return exact;
  const names = [...new Set(masteryItems().filter((m) => norm(m.name).startsWith(t)).map((m) => m.name))];
  return names.length === 1 ? masteryItems().filter((m) => m.name === names[0]) : [];
}

function bulkApply(text, mode) {
  const matched = [];
  const unmatched = [];
  for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    if (mode === 'mastery') {
      const hits = matchMasteryLine(line);
      if (!hits.length) unmatched.push(line);
      else {
        for (const m of hits) state.mastered[m.id] = true;
        matched.push(`${line} → ${hits[0].name} mastered`);
      }
      continue;
    }
    const hit = matchInventoryLine(line);
    if (!hit) unmatched.push(line);
    else if (hit.kind === 'relic') {
      const r = (state.relics[hit.name] ??= {});
      r[hit.ref] = (r[hit.ref] ?? 0) + hit.qty;
      matched.push(`${line} → ${hit.qty}× ${hit.name} ${REF_LABEL[hit.ref]}`);
    } else {
      state.parts[hit.name] = owned(hit.name) + hit.qty;
      matched.push(`${line} → ${hit.qty}× ${hit.name}`);
    }
  }
  return { matched, unmatched };
}

// ---- Screenshots: read item names from images the player saved ----------------

const fuzzyInventory = () =>
  (fuzzyInventory.fn ??= createFuzzy([
    ...Object.keys(DATA.relics).flatMap((r) => [
      { key: norm(r), value: `relic|${r}` },
      { key: `${norm(r)} relic`, value: `relic|${r}` },
    ]),
    ...Object.keys(DATA.parts).flatMap((p) => [
      { key: norm(p), value: `part|${p}` },
      // "Ash Prime Systems" may lose its "Blueprint" line, but a set's main blueprint must say so.
      ...(p.endsWith(' Blueprint') && !DATA.sets[p.slice(0, -10)] ? [{ key: norm(p.slice(0, -10)), value: `part|${p}` }] : []),
    ]),
  ]));
const fuzzyRef = createFuzzy(REFS.map((r) => ({ key: r, value: r })));

// Exact name first, then the closest known name allowing OCR slips. Stricter than bulk paste:
// a partly read tile such as "Aksomati Prime" must not turn into a blueprint by prefix.
function matchReadText(text) {
  const readings = quantityReadings(text);
  for (const { qty, rest } of readings) {
    const relic = resolveRelic(rest);
    if (relic) return { kind: 'relic', name: relic, qty: Math.max(1, qty) };
    const part = partIndex().get(norm(rest));
    if (part) return { kind: 'part', name: part, qty: Math.max(1, qty) };
  }
  for (const { qty, rest } of readings) {
    const hit = fuzzyInventory()(norm(rest));
    if (hit) {
      const [kind, name] = hit.split('|');
      return { kind, name, qty: Math.max(1, qty) };
    }
  }
  return null;
}

const masteryNames = () => (masteryNames.map ??= new Map(masteryItems().map((m) => [norm(m.name), m.name])));
const fuzzyMastery = () => (fuzzyMastery.fn ??= createFuzzy([...masteryNames()].map(([key, value]) => ({ key, value }))));

// Profile → Equipment tiles read "<NAME> MAX RANK" once mastered ("RANK 28" while levelling).
// Art behind the label adds junk words, so try runs of words, longest first, exact before fuzzy.
function readMasteryTile(words) {
  const rest = words.filter((w) => w !== 'max' && w !== 'rank' && !/^\d+$/.test(w));
  const runs = [];
  for (let len = rest.length; len >= 1; len--) for (let i = 0; i + len <= rest.length; i++) runs.push(rest.slice(i, i + len).join(' '));
  const name = runs.map((r) => masteryNames().get(r)).find(Boolean) ?? runs.filter((r) => r.length >= 4).map((r) => fuzzyMastery()(r)).find(Boolean);
  if (!name) return null;
  const item = { kind: 'mastery', name, ref: null };
  return { ...item, key: shotRowKey(item) };
}

// Relic codes are one letter then digits ("S18", "I1", "Z7"). OCR swaps look-alikes both ways
// ("Z7" comes back as "77", "A4" as "Ad"), so every likely reading is tried and only codes of real
// relics count. When two real relics fit, this pass stays silent and the other passes decide.
const fuzzyEra = createFuzzy(['lith', 'meso', 'neo', 'axi', 'requiem', 'vanguard'].map((e) => ({ key: e, value: e })));
const AS_LETTER = { 0: 'od', 1: 'i', l: 'i', 2: 'z', 4: 'a', 5: 's', 6: 'g', 7: 'tz', 8: 'b' };
const AS_DIGIT = { o: '0', d: '04', i: '1', l: '1', t: '17', z: '2', s: '5', g: '6', b: '68', q: '9', a: '4' };
function codeReadings(raw) {
  if (raw.length < 2 || raw.length > 4) return [];
  const firsts = /[a-z]/.test(raw[0]) ? [raw[0]] : [...(AS_LETTER[raw[0]] ?? '')];
  let codes = firsts;
  for (const c of raw.slice(1)) {
    const opts = /\d/.test(c) ? [c] : [...(AS_DIGIT[c] ?? '')];
    codes = codes.flatMap((code) => opts.map((o) => code + o));
  }
  return codes;
}
function readRelicCode(words) {
  const found = new Set();
  for (let i = 0; i < words.length; i++) {
    const era = words[i].length >= 3 && fuzzyEra(words[i], 0.34);
    if (!era) continue;
    // The code normally follows the era, but some reads come back as "75 Relic Neo".
    for (const raw of [words[i + 1], words[i - 1]]) {
      if (!raw || raw === 'relic') continue;
      for (const code of codeReadings(raw)) {
        const name = resolveRelic(`${era} ${code}`);
        if (name) found.add(name);
      }
    }
    if (found.size) break;
  }
  return found.size === 1 ? [...found][0] : null;
}

function readTile(tile) {
  const all = norm(tile.text).split(' ');
  if (all.includes('rank')) return all.includes('max') ? readMasteryTile(all) : null;
  let ref = 'intact';
  const words = norm(tile.text)
    .split(' ')
    .filter((w) => {
      const r = w.length >= 5 && fuzzyRef(w, 0.25);
      if (r) ref = r;
      return !r;
    });
  const relic = readRelicCode(words);
  const hit = relic ? { kind: 'relic', name: relic } : words.length ? matchReadText(words.join(' ')) : null;
  if (!hit) return null;
  // The quantity comes from the count drawn on the tile, never from numbers inside the name text.
  const item = { kind: hit.kind, name: hit.name, ref: hit.kind === 'relic' ? ref : null };
  return { ...item, key: shotRowKey(item) };
}

const shotRowKey = (r) => `${r.kind}|${r.name}|${r.ref ?? ''}`;

async function runShots(files) {
  const sh = ui.shots;
  const images = [...files].filter((f) => f.type.startsWith('image/'));
  if (sh.busy || !images.length) return;
  Object.assign(sh, { busy: true, progress: 'Loading the text reader…' });
  render();
  try {
    const pages = await readImages(images, (msg) => {
      sh.progress = msg;
      const el = document.getElementById('shot-progress');
      if (el) el.textContent = msg;
    });
    // Screenshots taken while scrolling overlap, so an item seen twice counts once, at its highest quantity.
    const rows = new Map(sh.rows.map((r) => [shotRowKey(r), r]));
    const unread = new Set(sh.unread);
    for (const { passes, light } of pages) {
      const found = combinePasses(passes, readTile);
      for (const { key, kind, name, ref, qty, read, box, sure } of found.items) {
        // The relic screen also lists relics you do not own, with a greyed out icon.
        if (kind === 'relic' && light(box) < 0.015) {
          sh.greyed = (sh.greyed ?? 0) + 1;
          continue;
        }
        const prev = rows.get(key);
        if (!prev || prev.qty < qty) rows.set(key, { kind, name, ref, qty, read, sure: sure || Boolean(prev?.sure), on: true, ok: true, replace: false });
      }
      // Only text that looks like an item name is worth showing, not menu labels.
      for (const t of found.unread) if (/\b(prime|relic|blueprint)\b/i.test(t) && !/\brank\b/i.test(t)) unread.add(t);
    }
    // Rows the passes disagreed on come first, they are the ones worth checking.
    sh.rows = [...rows.values()].sort((a, b) => a.sure - b.sure || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, 'en', { numeric: true }));
    sh.unread = [...unread];
    toast(`Found ${sh.rows.length} item${sh.rows.length === 1 ? '' : 's'}, check them before adding`);
  } catch (err) {
    toast(`Could not read the screenshots: ${err.message}`);
  } finally {
    sh.busy = false;
    render();
  }
}

// What the vault holds now for a review row.
function shotHave(r) {
  if (r.kind === 'mastery') return masteryItems().some((m) => m.name === r.name && state.mastered[m.id]) ? 1 : 0;
  if (r.kind === 'relic') return state.relics[r.name]?.[r.ref] ?? 0;
  return owned(r.name);
}

function shotsPanel() {
  const sh = (ui.shots ??= { busy: false, progress: '', rows: [], unread: [], greyed: 0 });
  const checked = sh.rows.filter((r) => r.on && r.ok).length;
  const owning = sh.rows.filter((r) => r.ok && r.kind !== 'mastery' && shotHave(r) > 0);
  const unsure = sh.rows.filter((r) => !r.sure).length;
  const vaultCell = (r, i) => {
    const have = shotHave(r);
    if (r.kind === 'mastery') return have ? '<span class="muted small">Already mastered</span>' : '<span class="muted small">New</span>';
    if (!have) return '<span class="muted small">New</span>';
    return `<span class="warn small">Have ${have}</span>
      <label class="small"><input type="checkbox" ${r.replace ? 'checked' : ''} data-change="shot-field" data-field="replace" data-i="${i}"> Replace</label>
      <div class="small muted">${r.replace ? `Will be set to ${r.qty}` : `Will become ${have + r.qty}`}</div>`;
  };
  const rows = sh.rows.map(
    (r, i) => `<tr class="${r.on ? '' : 'dim'}">
      <td><input type="checkbox" ${r.on ? 'checked' : ''} data-change="shot-field" data-field="on" data-i="${i}" aria-label="Add this item"></td>
      <td><input class="grow" list="${r.kind === 'mastery' ? 'dl-mastery' : 'dl-inventory'}" value="${esc(r.name)}" data-change="shot-name" data-i="${i}" data-focus="shot-name:${i}" aria-label="Item">
        ${r.ok ? '' : '<div class="miss small">Unknown name, pick one from the list</div>'}
        ${r.sure ? '' : '<span class="badge check" title="The reading passes disagreed on this tile, or only one could read it. Compare with the Read as column.">check</span>'}</td>
      <td>${
        r.kind === 'relic'
          ? `<select data-change="shot-field" data-field="ref" data-i="${i}" aria-label="Refinement">${REFS.map((x) => `<option value="${x}"${r.ref === x ? ' selected' : ''}>${REF_LABEL[x]}</option>`).join('')}</select>`
          : `<span class="muted small">${r.kind === 'mastery' ? 'Mastered' : 'Part'}</span>`
      }</td>
      <td class="num">${r.kind === 'mastery' ? '' : `<input type="number" min="1" value="${r.qty}" data-change="shot-field" data-field="qty" data-i="${i}" data-focus="shot-qty:${i}" aria-label="Quantity">`}</td>
      <td>${vaultCell(r, i)}</td>
      <td class="muted small hide-sm">${esc(r.read)}</td>
    </tr>`,
  );
  return `
    <div class="panel">
      <h3>Add from screenshots</h3>
      <p class="small muted">Take screenshots in game (the GeForce Now overlay or your system's screenshot key both work), then choose them here, drop them on the box or paste one with Ctrl+V.
        Works with Inventory → Prime Parts, Void Relics, and Profile → Equipment for mastery (items showing MAX RANK are marked mastered).
        The text is read on your device and the images are never uploaded. Text recognition makes mistakes, so check names and quantities before adding.</p>
      <div class="drop" data-drop>
        <button type="button" data-action="shots-pick" ${sh.busy ? 'disabled' : ''}>Choose screenshots</button>
        <input type="file" accept="image/*" multiple data-change="shots-files" hidden>
        <span class="small muted">${sh.busy ? `<span id="shot-progress">${esc(sh.progress)}</span>` : 'or drop images here, or paste one'}</span>
      </div>
      ${
        sh.rows.length
          ? `${sh.greyed ? `<p class="small muted" style="margin-top:12px">Skipped ${sh.greyed} greyed out relic${sh.greyed === 1 ? '' : 's'} you do not own.</p>` : ''}
             ${unsure ? `<p class="small"><span class="badge check">check</span> ${unsure} row${unsure === 1 ? '' : 's'} where the reading passes disagreed are listed first. Look at those names before adding, misreads such as S3 for B3 end up there.</p>` : ''}
             ${owning.length ? `<p class="small"><span class="warn">${owning.length} of these are already in your vault.</span> By default the new quantity is added to what you have. Tick Replace to set it to the screenshot's number instead, which is what you want when re-scanning a screen.</p>` : ''}
             <div class="table-wrap" style="margin-top:12px"><table>
               <thead><tr><th></th><th>Item</th><th>Refinement</th><th class="num">Qty</th><th>In vault</th><th class="hide-sm">Read as</th></tr></thead>
               <tbody>${rows.join('')}</tbody>
             </table></div>
             <div class="toolbar">
               <button class="primary" data-action="shots-add" ${checked ? '' : 'disabled'}>Add ${checked} checked to vault</button>
               <button class="ghost" data-action="shots-clear">Discard</button>
               ${owning.length ? `<button class="small" data-action="shots-replace-all" data-value="${owning.every((r) => r.replace) ? '0' : '1'}">${owning.every((r) => r.replace) ? 'Add to all instead' : `Replace all ${owning.length} already in vault`}</button>` : ''}
               <span class="spacer"></span>
               <span class="small muted">Added to what you have unless Replace is ticked.</span>
             </div>`
          : ''
      }
      ${
        sh.unread.length
          ? `<details><summary class="small muted">${sh.unread.length} bits of text not recognised as an item</summary>
               <div class="small muted">${sh.unread.map(esc).join('<br>')}</div>
               <p class="small muted">If one of these is an item, add it by hand or fix it in Bulk paste below.</p></details>`
          : ''
      }
    </div>`;
}

ACTIONS['shots-pick'] = () => view.querySelector('input[data-change=shots-files]')?.click();
CHANGES['shots-files'] = (el) => runShots(el.files ?? []);
CHANGES['shot-field'] = (el) => {
  const row = ui.shots.rows[el.dataset.i];
  if (!row) return;
  if (el.dataset.field === 'on') row.on = el.checked;
  if (el.dataset.field === 'ref') row.ref = el.value;
  if (el.dataset.field === 'qty') row.qty = Math.max(1, Math.floor(Number(el.value) || 1));
  if (el.dataset.field === 'replace') row.replace = el.checked;
  render();
};
ACTIONS['shots-replace-all'] = (el) => {
  for (const r of ui.shots.rows) if (r.ok && r.kind !== 'mastery' && shotHave(r) > 0) r.replace = el.dataset.value === '1';
  render();
};
CHANGES['shot-name'] = (el) => {
  const row = ui.shots.rows[el.dataset.i];
  if (!row) return;
  if (row.kind === 'mastery') {
    const hits = matchMasteryLine(el.value);
    Object.assign(row, hits.length ? { name: hits[0].name, ok: true, on: true, sure: true } : { name: el.value, ok: false });
    return render();
  }
  const hit = matchInventoryLine(el.value) ?? matchReadText(el.value);
  if (hit) Object.assign(row, { kind: hit.kind, name: hit.name, ref: hit.kind === 'relic' ? (row.ref ?? 'intact') : null, ok: true, on: true, sure: true });
  else Object.assign(row, { name: el.value, ok: false });
  render();
};
ACTIONS['shots-add'] = () => {
  const take = ui.shots.rows.filter((r) => r.on && r.ok);
  checkpoint();
  for (const r of take) {
    if (r.kind === 'mastery') {
      for (const m of masteryItems()) if (m.name === r.name) state.mastered[m.id] = true;
    } else if (r.kind === 'relic') {
      const c = (state.relics[r.name] ??= {});
      c[r.ref] = (r.replace ? 0 : (c[r.ref] ?? 0)) + r.qty;
    } else state.parts[r.name] = (r.replace ? 0 : owned(r.name)) + r.qty;
  }
  ui.shots.rows = ui.shots.rows.filter((r) => !(r.on && r.ok));
  if (!ui.shots.rows.length) Object.assign(ui.shots, { unread: [], greyed: 0 });
  save(`Added ${take.length} item${take.length === 1 ? '' : 's'} from screenshots`, true);
  render();
};
ACTIONS['shots-clear'] = () => {
  Object.assign(ui.shots, { rows: [], unread: [], greyed: 0 });
  render();
};

view.addEventListener('dragover', (e) => {
  const zone = e.target.closest('[data-drop]');
  if (!zone) return;
  e.preventDefault();
  zone.classList.add('over');
});
view.addEventListener('dragleave', (e) => e.target.closest('[data-drop]')?.classList.remove('over'));
view.addEventListener('drop', (e) => {
  if (!e.target.closest('[data-drop]')) return;
  e.preventDefault();
  runShots(e.dataTransfer?.files ?? []);
});
document.addEventListener('paste', (e) => {
  if (currentTab() !== 'data') return;
  const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  e.preventDefault();
  runShots(files);
});

VIEWS.data = () => {
  const b = (ui.bulk ??= { mode: 'inventory', text: '', report: null });
  const r = b.report;
  return `
    ${head('Data', 'Your inventory lives in this browser. Export a backup now and then, or turn on sync at the bottom to share it between your devices.')}
    ${shotsPanel()}
    <div class="panel">
      <h3>Bulk paste</h3>
      <p class="small muted">One item per line. Counts are added to what you already have.</p>
      <form data-form="bulk">
        <div class="toolbar">
          <select name="mode" data-change="bulk-mode" aria-label="What you are pasting">
            <option value="inventory"${b.mode === 'inventory' ? ' selected' : ''}>Relics and prime parts</option>
            <option value="mastery"${b.mode === 'mastery' ? ' selected' : ''}>Mastered items</option>
          </select>
          <span class="spacer"></span>
          <button class="primary">Add to vault</button>
        </div>
        <textarea name="text" data-focus="bulk-text" spellcheck="false" placeholder="${
          b.mode === 'mastery'
            ? 'Loki Prime\nSoma Prime\nNikana'
            : '3x Lith G1\nNeo H4 Relic (Radiant) x2\n2 Axi S2 Exceptional\nLoki Prime Chassis\nAsh Prime Systems x2'
        }">${esc(b.text)}</textarea>
      </form>
      ${
        r
          ? `<div style="margin-top:12px">
               <p class="small"><span class="ok">${r.matched.length} matched</span>${r.unmatched.length ? `, <span class="miss">${r.unmatched.length} not recognised</span>` : ''}</p>
               ${r.unmatched.length ? `<div class="note small"><b>Not recognised</b>, fix and paste these again:<br>${r.unmatched.map(esc).join('<br>')}</div>` : ''}
               ${r.matched.length ? `<details><summary class="small muted">Show matched lines</summary><div class="small muted">${r.matched.map(esc).join('<br>')}</div></details>` : ''}
             </div>`
          : ''
      }
    </div>
    <div class="panel">
      <h3>Backup</h3>
      <div class="row" style="margin-top:8px">
        <button data-action="export">Export JSON</button>
        <label class="row"><button type="button" data-action="import-pick">Import JSON</button>
          <input type="file" accept="application/json,.json" data-change="import" hidden></label>
        <span class="spacer"></span>
        <button class="danger" data-action="reset">Reset everything</button>
      </div>
      <p class="small muted">Importing replaces everything in this browser with the file's contents.</p>
    </div>
    ${syncPanel()}`;
};

FORMS.bulk = (form, fd) => {
  const mode = fd.get('mode');
  const text = String(fd.get('text') ?? '');
  checkpoint();
  const report = bulkApply(text, mode);
  ui.bulk = { mode, text: report.unmatched.join('\n'), report };
  save(`Added ${report.matched.length} line${report.matched.length === 1 ? '' : 's'}`, true);
  render();
};
CHANGES['bulk-mode'] = (el) => {
  ui.bulk.mode = el.value;
  ui.bulk.text = view.querySelector('textarea[name=text]')?.value ?? '';
  render();
};
ACTIONS.export = () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `lokisvault-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Backup downloaded');
};
ACTIONS['import-pick'] = () => view.querySelector('input[data-change=import]')?.click();
CHANGES.import = async (el) => {
  const file = el.files?.[0];
  if (!file) return;
  try {
    const raw = JSON.parse(await file.text());
    if (!raw || typeof raw !== 'object' || raw.v !== 1) throw new Error('not a Loki’s Vault backup');
    if (!confirm('Replace everything in this browser with this backup?')) return;
    checkpoint();
    state = sanitize(raw);
    save('Backup imported', true);
    render();
  } catch (err) {
    toast(`Import failed: ${err.message}`);
  }
};
ACTIONS.reset = () => {
  const where = sync?.token ? 'in this browser and, through sync, on your other devices' : 'in this browser';
  if (!confirm(`Delete every relic, part, wishlist set and mastery mark stored ${where}? Export a backup first if unsure.`)) return;
  checkpoint();
  state = emptyState();
  save('Vault reset', true);
  render();
};

// ---- Sync: optional copy in the player's own secret GitHub Gist ------------------
// Off unless the player pastes a GitHub token that can only manage gists. The token stays in this
// browser under its own key, so it is never part of an exported backup. Newest copy wins.

const SYNC_KEY = 'lokisvault:sync';
const BEFORE_SYNC_KEY = 'lokisvault:v1:before-sync';
const GIST_FILE = 'lokisvault.json';
const TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=gist&description=Loki%27s%20Vault%20sync';

const readJson = (key) => {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
};
const writeJson = (key, value) => {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {}
};

let sync = readJson(SYNC_KEY); // { token, gistId, at } or null
let syncBusy = null;
let syncAgain = false; // a change landed while a sync was running
let pushTimer;
const syncStatus = { error: null };

const isEmptyVault = (s) =>
  !Object.keys(s.relics).length && !Object.keys(s.parts).length && !s.wishlist.length && !Object.keys(s.mastered).length;

async function gh(path, { method = 'GET', body, token = sync?.token } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  if (res.status === 401) throw Object.assign(new Error('GitHub rejected the token, it may have expired'), { status: 401 });
  if (res.status === 404) throw Object.assign(new Error('not found'), { status: 404 });
  if (!res.ok) throw Object.assign(new Error(`GitHub answered ${res.status}`), { status: res.status });
  return res.json();
}

async function gistVault(gist) {
  const file = gist.files?.[GIST_FILE];
  if (!file) return null;
  const text = file.truncated ? await (await fetch(file.raw_url, { cache: 'no-store' })).text() : file.content;
  const raw = JSON.parse(text);
  return raw?.v === 1 ? raw : null;
}

async function findVaultGist(token) {
  for (let page = 1; page <= 5; page++) {
    const list = await gh(`/gists?per_page=100&page=${page}`, { token });
    const hit = list.find((g) => g.files?.[GIST_FILE]);
    if (hit) return hit.id;
    if (list.length < 100) return null;
  }
  return null;
}

const gistBody = () => ({
  description: "Loki's Vault: Warframe inventory backup (https://dpaess.github.io/LokisVault/)",
  files: { [GIST_FILE]: { content: JSON.stringify(state, null, 1) } },
});

async function pushGist() {
  if (sync.gistId) {
    try {
      return await gh(`/gists/${sync.gistId}`, { method: 'PATCH', body: gistBody() });
    } catch (err) {
      if (err.status !== 404) throw err; // the gist was deleted on GitHub: make a new one
    }
  }
  const gist = await gh('/gists', { method: 'POST', body: { ...gistBody(), public: false } });
  sync.gistId = gist.id;
  return gist;
}

// Replaces this browser's vault with one from the Gist, keeping the old one restorable.
function adoptRemote(remote) {
  if (!isEmptyVault(state)) writeJson(BEFORE_SYNC_KEY, state);
  state = sanitize(remote);
  writeLocal();
}

// Pulls when the Gist is newer, pushes when this browser is newer. Runs one at a time.
function syncNow({ quiet = true } = {}) {
  if (!sync?.token) return Promise.resolve();
  if (syncBusy) {
    syncAgain = true;
    return syncBusy;
  }
  syncBusy = (async () => {
    try {
      let remote = null;
      if (sync.gistId) {
        try {
          remote = await gistVault(await gh(`/gists/${sync.gistId}`));
        } catch (err) {
          if (err.status !== 404) throw err;
        }
      }
      const remoteAt = Number(remote?.savedAt) || 0;
      if (remote && remoteAt > state.savedAt) {
        adoptRemote(remote);
        toast('Loaded newer data from your Gist');
        render();
      } else if (!remote || remoteAt < state.savedAt) {
        await pushGist();
        if (!quiet) toast('Saved to your Gist');
      } else if (!quiet) toast('Already in sync');
      sync.at = Date.now();
      syncStatus.error = null;
      writeJson(SYNC_KEY, sync);
    } catch (err) {
      syncStatus.error = err.message;
      if (!quiet || err.status === 401) toast(`Sync failed: ${err.message}`);
    } finally {
      syncBusy = null;
      if (syncAgain) {
        syncAgain = false;
        schedulePush();
      }
      // Refresh the status, but never under someone typing (a half written bulk paste would be lost).
      if (currentTab() === 'data' && !view.contains(document.activeElement)) render();
    }
  })();
  return syncBusy;
}

function schedulePush() {
  if (!sync?.token) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => syncNow(), 2000);
}

function syncPanel() {
  const when = (t) => (t ? new Date(t).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' }) : 'never');
  const prev = readJson(BEFORE_SYNC_KEY);
  const body = sync?.token
    ? `<p class="small">Connected. Last synced ${esc(when(sync.at))}${syncBusy ? ', syncing now…' : ''}.
         ${sync.gistId ? `Your data is in <a href="https://gist.github.com/${esc(sync.gistId)}" target="_blank" rel="noopener">this secret Gist</a>.` : ''}</p>
       ${syncStatus.error ? `<div class="note small">Last sync failed: ${esc(syncStatus.error)}. Your data is still saved in this browser.</div>` : ''}
       <div class="row" style="margin-top:8px">
         <button data-action="sync-now" ${syncBusy ? 'disabled' : ''}>Sync now</button>
         ${prev ? '<button class="ghost" data-action="sync-restore">Restore the copy from before the last download</button>' : ''}
         <span class="spacer"></span>
         <button class="danger" data-action="sync-off">Disconnect this browser</button>
       </div>`
    : `<ol class="small">
         <li><a href="${TOKEN_URL}" target="_blank" rel="noopener">Create a GitHub token</a> (GitHub account needed). The link already ticks only the <b>gist</b> permission, so the token cannot touch anything else. Pick an expiry you like and click Generate.</li>
         <li>Paste it below and connect. The site finds your existing vault Gist or creates a new secret one.</li>
         <li>Do the same on your other devices with the same token.</li>
       </ol>
       <form class="toolbar" data-form="sync-connect">
         <input class="grow" type="password" name="token" placeholder="ghp_…" autocomplete="off" spellcheck="false" required aria-label="GitHub token">
         <button class="primary">Connect</button>
       </form>`;
  return `
    <details class="panel"${sync?.token ? ' open' : ''}>
      <summary><h3 style="display:inline">Sync between devices (optional)</h3></summary>
      <p class="small muted">Keeps a copy of your vault in a secret Gist on your own GitHub account, so your PC and phone show the same data.
        It loads the newest copy when you open the site and saves about two seconds after each change. The token stays in this browser only and is never part of an exported backup.
        Secret Gists are unlisted, not encrypted: anyone with the exact link could read your inventory.</p>
      ${body}
    </details>`;
}

FORMS['sync-connect'] = async (form, fd) => {
  const token = String(fd.get('token') ?? '').trim();
  if (!token) return;
  try {
    toast('Connecting to GitHub…');
    const gistId = await findVaultGist(token);
    sync = { token, gistId, at: null };
    if (gistId) {
      const remote = await gistVault(await gh(`/gists/${gistId}`));
      const useRemote =
        remote &&
        (isEmptyVault(state) ||
          confirm(`Your Gist already has a vault, saved ${new Date(Number(remote.savedAt) || 0).toLocaleString('en')}.\n\nOK: load it into this browser (the data here is kept as a restorable copy).\nCancel: keep this browser's data and upload it to the Gist.`));
      if (useRemote) adoptRemote(remote);
      else {
        state.savedAt = Date.now();
        writeLocal();
        await pushGist();
      }
    } else await pushGist();
    sync.at = Date.now();
    syncStatus.error = null;
    writeJson(SYNC_KEY, sync);
    toast(gistId ? 'Connected to your existing vault Gist' : 'Connected, created a secret Gist for your vault');
  } catch (err) {
    sync = null;
    toast(`Could not connect: ${err.message}`);
  }
  render();
};
ACTIONS['sync-now'] = () => syncNow({ quiet: false });
ACTIONS['sync-off'] = () => {
  if (!confirm('Disconnect this browser? Your data stays here and in the Gist, only the token is removed from this browser.')) return;
  sync = null;
  writeJson(SYNC_KEY, null);
  toast('Disconnected');
  render();
};
ACTIONS['sync-restore'] = () => {
  const prev = readJson(BEFORE_SYNC_KEY);
  if (!prev || !confirm('Replace the current data with the copy this browser had before the last download from your Gist?')) return;
  state = sanitize(prev);
  writeJson(BEFORE_SYNC_KEY, null);
  save('Previous copy restored');
  render();
};

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && sync?.token && Date.now() - (sync.at ?? 0) > 30000) syncNow();
});

// ---- Rendering and events --------------------------------------------------

const currentTab = () => {
  const t = location.hash.slice(1);
  return VIEWS[t] ? t : 'overview';
};

// Re-rendering replaces the DOM, so remember which field had focus (by data-focus) and restore it.
function render() {
  const tab = currentTab();
  const active = document.activeElement;
  const key = view.contains(active) ? active.dataset.focus : null;
  const sel = key && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;

  for (const a of document.querySelectorAll('#tabs a')) {
    const on = a.getAttribute('href') === `#${tab}`;
    a.classList.toggle('active', on);
    if (on) a.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  view.innerHTML = VIEWS[tab]();

  if (key) {
    const el = view.querySelector(`[data-focus="${CSS.escape(key)}"]`);
    if (el) {
      el.focus();
      if (sel) try { el.setSelectionRange(...sel); } catch {}
    }
  }
}

view.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (el && ACTIONS[el.dataset.action]) ACTIONS[el.dataset.action](el, e);
});
view.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (el && CHANGES[el.dataset.change]) CHANGES[el.dataset.change](el, e);
});
view.addEventListener('submit', (e) => {
  const form = e.target.closest('[data-form]');
  if (!form || !FORMS[form.dataset.form]) return;
  e.preventDefault();
  FORMS[form.dataset.form](form, new FormData(form));
});
let inputTimer;
view.addEventListener('input', (e) => {
  const el = e.target.closest('[data-input]');
  if (!el || !INPUTS[el.dataset.input]) return;
  clearTimeout(inputTimer);
  inputTimer = setTimeout(() => INPUTS[el.dataset.input](el), 150);
});
// Ctrl+Z (Cmd+Z) undoes the last change, unless you are typing in a field.
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.key.toLowerCase() !== 'z') return;
  if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  e.preventDefault();
  undo();
});
window.addEventListener('hashchange', () => {
  render();
  window.scrollTo(0, 0);
});

function fillDatalists() {
  const opts = (names) => names.map((n) => `<option value="${esc(n)}"></option>`).join('');
  document.getElementById('dl-relics').innerHTML = opts(Object.keys(DATA.relics));
  document.getElementById('dl-parts').innerHTML = opts(Object.keys(DATA.parts).sort());
  document.getElementById('dl-sets').innerHTML = opts(Object.keys(DATA.sets).sort());
  document.getElementById('dl-mastery').innerHTML = opts([...new Set(masteryItems().map((m) => m.name))].sort());
  document.getElementById('dl-inventory').innerHTML = opts([...Object.keys(DATA.relics), ...Object.keys(DATA.parts).sort()]);
}

function fillSources() {
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' }) : 'never');
  document.getElementById('sources').textContent =
    `Game data ${day(DATA.generatedAt)} (${DATA.sources.items}). Prices ${day(PRICES_AT)} from warframe.market.`;
}

async function init() {
  try {
    const [items, prices] = await Promise.all([
      fetch('data/items.json').then((r) => {
        if (!r.ok) throw new Error(`items.json HTTP ${r.status}`);
        return r.json();
      }),
      fetch('data/prices.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    DATA = items;
    PRICES = prices?.prices ?? {};
    PRICES_AT = prices?.generatedAt ?? null;
  } catch (err) {
    view.innerHTML = `<div class="empty">Could not load game data (${esc(err.message)}). Try reloading.</div>`;
    return;
  }
  state = loadState();
  fillDatalists();
  fillSources();
  render();
  syncNow();
}

init();
