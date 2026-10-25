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
