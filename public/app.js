// Loki's Vault: all UI logic. Vanilla ES module, no build step.
// Game data comes from data/items.json and data/prices.json (built by scripts/).
// The player's inventory lives in localStorage under STORE_KEY.

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

function toast(msg) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.remove(), 2400);
}

// ---- State -----------------------------------------------------------------

const emptyState = () => ({ v: 1, relics: {}, parts: {}, wishlist: [], mastered: {}, settings: { ducatRatio: 10 } });

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
  return s;
}

function loadState() {
  try {
    return sanitize(JSON.parse(localStorage.getItem(STORE_KEY) || 'null'));
  } catch {
    return emptyState();
  }
}

function save(msg) {
  state = sanitize(state);
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    toast('Could not save: browser storage is unavailable');
    return;
  }
  if (msg) toast(msg);
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
    .sort((a, b) => b.n - a.n || relicTotal(b.r) - relicTotal(a.r))
    .slice(0, 5);
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
          ? `<p class="muted small">Your relics with the most parts you still need. Crack these first.</p>
             <div class="rewards">${topRelics
               .map(({ r, n }) => `<div class="reward"><span><b>${esc(r)}</b> <span class="muted">×${relicTotal(r)}</span></span><span class="meta">${n} needed part${n > 1 ? 's' : ''}</span></div>`)
               .join('')}</div>`
          : `<p class="muted">No owned relic contains a part your wishlist still needs.</p>`
      }
      ${
        noSource.length
          ? `<p class="muted small" style="margin-top:14px">Needed parts you own no relic for. See <a href="#wishlist">Wishlist</a> for where to farm or buy them.</p>
             <div class="rewards">${noSource
               .map((p) => `<div class="reward"><span>${esc(p)}</span><span class="meta">${DATA.parts[p]?.farmable ? '<span class="badge farm">Farmable</span>' : '<span class="badge vault">Vaulted</span>'}</span></div>`)
               .join('')}</div>`
          : ''
      }
    </div>`;
};

// ---- Relics ------------------------------------------------------------------

const relicIndex = () => (relicIndex.map ??= new Map(Object.keys(DATA.relics).map((k) => [norm(k), k])));
const resolveRelic = (text) => relicIndex().get(norm(text).replace(/\brelic\b/g, '').replace(/\s+/g, ' ').trim()) ?? null;

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

VIEWS.relics = () => {
  const need = needs();
  const f = (ui.relics ??= { filter: 'all', sort: 'ev' });
  const hasWanted = (r) => DATA.relics[r].rewards.some((w) => missingOf(need, w.item) > 0);
  let names = Object.keys(state.relics);
  if (f.filter === 'wanted') names = names.filter(hasWanted);
  if (f.filter === 'vaulted') names = names.filter((r) => !DATA.relics[r].farmable);
  const evOf = (r) => relicEV(r, bestRef(r)).plat;
  const sorters = {
    ev: (a, b) => evOf(b) - evOf(a),
    name: (a, b) => a.localeCompare(b, 'en', { numeric: true }),
    count: (a, b) => relicTotal(b) - relicTotal(a),
  };
  names.sort(sorters[f.sort] ?? sorters.ev);
  const total = Object.keys(state.relics).length;

  return `
    ${head('Relics', 'Every relic you own, by refinement. Parts your wishlist still needs are highlighted in blue. EV is the average platinum and ducats one opening is worth at market prices.')}
    <form class="toolbar" data-form="relic-add">
      <input class="grow" name="name" list="dl-relics" placeholder="Relic, e.g. Neo H4" autocomplete="off" data-focus="relic-add" required>
      <select name="ref">${REFS.map((r) => `<option value="${r}">${REF_LABEL[r]}</option>`).join('')}</select>
      <input type="number" name="qty" min="1" value="1" aria-label="Quantity">
      <button class="primary">Add</button>
    </form>
    <div class="toolbar">
      <select data-change="relic-filter" aria-label="Filter">
        ${[['all', 'All relics'], ['wanted', 'Has parts I need'], ['vaulted', 'Vaulted only']].map(([v, l]) => `<option value="${v}"${f.filter === v ? ' selected' : ''}>${l}</option>`).join('')}
      </select>
      <select data-change="relic-sort" aria-label="Sort">
        ${[['ev', 'Sort by EV'], ['name', 'Sort by name'], ['count', 'Sort by count']].map(([v, l]) => `<option value="${v}"${f.sort === v ? ' selected' : ''}>${l}</option>`).join('')}
      </select>
      <span class="spacer"></span>
      <span class="muted small">${names.length} of ${total} relics shown</span>
    </div>
    ${
      names.length
        ? `<div class="grid cards">${names.map((r) => relicCard(r, need)).join('')}</div>`
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
  const r = (state.relics[el.dataset.relic] ??= {});
  r[el.dataset.ref] = Math.max(0, Math.floor(Number(el.value) || 0));
  save();
  render();
};
CHANGES['relic-filter'] = (el) => {
  ui.relics.filter = el.value;
  render();
};
CHANGES['relic-sort'] = (el) => {
  ui.relics.sort = el.value;
  render();
};
ACTIONS['relic-remove'] = (el) => {
  delete state.relics[el.dataset.relic];
  save(`Removed ${el.dataset.relic}`);
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

VIEWS.parts = () => {
  const need = needs();
  const names = Object.keys(state.parts).sort((a, b) => partSortKey(a).localeCompare(partSortKey(b)));
  const buildable = Object.keys(DATA.sets).filter(setComplete);
  const rows = names.map((p) => {
    const n = need[p] ?? 0;
    const status = n ? (owned(p) >= n ? '<span class="ok">✓</span>' : `<span class="miss">${missingOf(need, p)} short</span>`) : '';
    return `<tr>
      <td>${esc(p)}</td>
      <td class="muted">${partSets(p).map(esc).join(', ') || '–'}</td>
      <td class="num"><input type="number" min="0" value="${owned(p)}" data-change="part-count" data-part="${esc(p)}" data-focus="part:${esc(p)}" aria-label="Owned"></td>
      <td class="num">${n || ''} ${status}</td>
      <td class="num">${fmtD(DATA.parts[p].ducats)}</td>
      <td class="num">${fmtP(priceOf(p))}</td>
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
             <thead><tr><th>Part</th><th>Set</th><th class="num">Owned</th><th class="num">Needed</th><th class="num">Ducats</th><th class="num">Price</th></tr></thead>
             <tbody>${rows.join('')}</tbody>
           </table></div>
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
  state.parts[el.dataset.part] = Math.max(0, Math.floor(Number(el.value) || 0));
  save();
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

VIEWS.wishlist = () => {
  const need = needs();
  const sets = [...state.wishlist].sort((a, b) => a.localeCompare(b));
  return `
    ${head('Wishlist', 'Prime sets you want to build. Missing parts show which of your relics can drop them, which relics you can farm today, or where to buy them if everything is vaulted.')}
    <form class="toolbar" data-form="wish-add">
      <input class="grow" name="name" list="dl-sets" placeholder="Set, e.g. Loki Prime" autocomplete="off" data-focus="wish-add" required>
      <button class="primary">Add</button>
    </form>
    ${
      sets.length
        ? `<div class="grid cards">${sets.map((s) => wishCard(s, need)).join('')}</div>`
        : '<div class="empty">Your wishlist is empty. Add a set above, or use “Add to wishlist” on an unmastered prime in Mastery.</div>'
    }`;
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
  state.wishlist = state.wishlist.filter((s) => s !== el.dataset.set);
  save(`Removed ${el.dataset.set} from your wishlist`);
  render();
};
ACTIONS['wish-built'] = (el) => {
  const set = el.dataset.set;
  const s = DATA.sets[set];
  if (!confirm(`Mark ${set} as built? Its parts you own are removed from your inventory and it is marked as mastered.`)) return;
  for (const p of s.parts) state.parts[p.name] = Math.max(0, owned(p.name) - p.count);
  state.wishlist = state.wishlist.filter((x) => x !== set);
  state.mastered[s.id] = true;
  save(`${set} built and marked as mastered`);
  render();
};

const todo = (title) => () => `${head(title)}<div class="empty">Coming soon.</div>`;
for (const [tab, title] of Object.entries({ relics: 'Relics', parts: 'Prime parts', wishlist: 'Wishlist', mastery: 'Mastery', trade: 'Sell or ducat', data: 'Data' })) {
  VIEWS[tab] ??= todo(title);
}

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

  for (const a of document.querySelectorAll('#tabs a')) a.classList.toggle('active', a.getAttribute('href') === `#${tab}`);
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
window.addEventListener('hashchange', () => {
  render();
  window.scrollTo(0, 0);
});

function fillDatalists() {
  const opts = (names) => names.map((n) => `<option value="${esc(n)}"></option>`).join('');
  document.getElementById('dl-relics').innerHTML = opts(Object.keys(DATA.relics));
  document.getElementById('dl-parts').innerHTML = opts(Object.keys(DATA.parts).sort());
  document.getElementById('dl-sets').innerHTML = opts(Object.keys(DATA.sets).sort());
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
}

init();
