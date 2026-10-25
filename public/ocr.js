// Reading item names out of screenshots the player saved themselves.
// Text recognition runs in the browser with Tesseract.js: the image never leaves the device,
// only the engine and its English model are downloaded (once, then cached) from jsDelivr.

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

let engine = null;
function loadEngine() {
  return (engine ??= new Promise((resolve, reject) => {
    if (window.Tesseract) return resolve(window.Tesseract);
    const s = document.createElement('script');
    s.src = TESSERACT_URL;
    s.onload = () => resolve(window.Tesseract);
    s.onerror = () => {
      engine = null;
      reject(new Error('could not download the text recognition engine'));
    };
    document.head.append(s);
  }));
}

// Each screenshot is read several times, prepared differently, and the readings are combined.
// Game text is light on a dark background behind busy item icons, and no single black and white
// cut works for every screen: the darkest colour channel hides gold icons, the brightest keeps
// coloured text. Measured on real screenshots, these passes together find nearly everything.
// The Profile → Equipment screen prints dark names on a light band, which the last pass reads.
const PASSES = [
  { channel: 'min', cut: 120 },
  { channel: 'min', cut: 'otsu' },
  { channel: 'max', cut: 150 },
  { channel: 'max', cut: 90, dark: true },
];

// Best split between dark and light for a histogram (Otsu's method).
function otsu(hist, total) {
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let cut = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const between = wB * wF * (sumB / wB - (sumAll - sumB) / wF) ** 2;
    if (between > best) [best, cut] = [between, i];
  }
  return cut;
}

// How lit the item icon above a name is: the share of bright pixels in the square just above it.
// Owned relics show a bright gold or silver icon (4 to 16% of pixels on real screenshots),
// relics you do not own are greyed out (under 0.2%).
export function iconLight(grey, w, h) {
  return ({ x0, y0, x1 }) => {
    const size = x1 - x0;
    const cx = (x0 + x1) / 2;
    const left = Math.max(0, Math.round(cx - 0.4 * size));
    const right = Math.min(w, Math.round(cx + 0.4 * size));
    const top = Math.max(0, Math.round(y0 - size));
    const bottom = Math.min(h, Math.round(y0 - 0.15 * size));
    let lit = 0;
    let all = 0;
    for (let y = top; y < bottom; y++)
      for (let x = left; x < right; x++) {
        all++;
        if (grey[y * w + x] >= 150) lit++;
      }
    return all ? lit / all : 0;
  };
}

// Scales the screenshot up and returns one black on white canvas per pass, plus the brightness
// channel for iconLight.
async function prepareImage(blob) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(3, Math.max(1, 2400 / bmp.width));
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const src = ctx.getImageData(0, 0, w, h).data;
  const channels = { min: new Uint8Array(w * h), max: new Uint8Array(w * h) };
  for (let i = 0, j = 0; i < src.length; i += 4, j++) {
    channels.min[j] = Math.min(src[i], src[i + 1], src[i + 2]);
    channels.max[j] = Math.max(src[i], src[i + 1], src[i + 2]);
  }
  const canvases = PASSES.map(({ channel, cut, dark }) => {
    const grey = channels[channel];
    if (cut === 'otsu') {
      const hist = new Uint32Array(256);
      for (const g of grey) hist[g]++;
      cut = otsu(hist, grey.length);
    }
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const octx = out.getContext('2d');
    const img = octx.createImageData(w, h);
    for (let j = 0; j < grey.length; j++) {
      // Text ends up black: light text normally, dark text for a dark pass.
      const v = (dark ? grey[j] < cut : grey[j] >= cut) ? 0 : 255;
      img.data[j * 4] = img.data[j * 4 + 1] = img.data[j * 4 + 2] = v;
      img.data[j * 4 + 3] = 255;
    }
    octx.putImageData(img, 0, 0);
    return out;
  });
  return { canvases, light: iconLight(channels.max, w, h) };
}

// Returns, for each image, { passes, light }: one array of words (with boxes and confidence) per
// pass, and iconLight for that image.
export async function readImages(blobs, onProgress = () => {}) {
  const T = await loadEngine();
  let step = '';
  const worker = await T.createWorker('eng', 1, {
    logger: (m) => {
      if (m.status === 'recognizing text') onProgress(`${step} ${Math.round(m.progress * 100)}%`);
      else if (m.status && !step) onProgress(`${m.status[0].toUpperCase()}${m.status.slice(1)}…`);
    },
  });
  try {
    // Sparse text: item names are scattered labels, not paragraphs.
    await worker.setParameters({ tessedit_pageseg_mode: '11' });
    const out = [];
    for (let i = 0; i < blobs.length; i++) {
      step = `Preparing image ${i + 1} of ${blobs.length}…`;
      onProgress(step);
      const passes = [];
      const { canvases, light } = await prepareImage(blobs[i]);
      for (let k = 0; k < canvases.length; k++) {
        step = `Reading image ${i + 1} of ${blobs.length}, pass ${k + 1} of ${canvases.length}…`;
        const { data } = await worker.recognize(canvases[k]);
        passes.push(
          (data.words ?? [])
            .filter((w) => w.confidence >= 20 && /[a-z0-9]/i.test(w.text))
            .map((w) => ({ text: w.text, conf: w.confidence, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 })),
        );
      }
      out.push({ passes, light });
    }
    return out;
  } finally {
    await worker.terminate();
  }
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
};
// Stack counts read "x4" on relics and "✓ 2" on prime parts, where the tick comes back as a symbol
// such as "@2". A bare number is not trusted as a count: it is more often a relic code ("Neo 02")
// or a stray read off an item icon.
const countOf = (w) => {
  const m = w.text.trim().match(/^(?:[x×]|[@©®✓√]+)?\s*(\d{1,3})$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (n < 1) return null;
  // Engines that read whole lines keep codes like "Neo 02" together, so a lone number is a count,
  // but icons (the era filter's ∞, the eye on unowned relics) also come back as faint digits.
  // Word by word engines split relic codes, so there a bare number is never trusted.
  if (/^\d+$/.test(w.text.trim())) return w.line && (w.conf ?? 0) >= 80 ? n : null;
  return n;
};

// The relic screen lists the selected relic's possible rewards on the right, under a
// "<relic> - Possible Rewards" title. Those are not owned items, so drop everything from that
// title's left edge rightwards.
export function dropRewardPanel(words) {
  const title = words.find((w) => /\b(possible|rewards?)\b/i.test(w.text) && !/^select\b/i.test(w.text));
  if (!title) return words;
  const h = title.y1 - title.y0;
  const sameLine = words
    .filter((w) => Math.min(w.y1, title.y1) - Math.max(w.y0, title.y0) > 0.5 * h && w.x1 <= title.x0)
    .sort((a, b) => b.x1 - a.x1);
  let edge = title.x0;
  for (const w of sameLine) {
    if (edge - w.x1 > 3 * h) break;
    edge = w.x0;
  }
  return words.filter((w) => w.x0 < edge - 0.5 * h);
}

// Groups words into tiles: words on one line close together, plus lines just below them that
// are roughly centred under them (inventory names wrap onto two or three lines).
// Counts become the quantity of the nearest tile below or beside them that read(tile) recognises,
// so junk read off an item icon cannot take the count. Each tile carries read(tile) as hit.
// Returns [{ text, qty, hit, x0, y0, x1, y1 }] with qty null when no count was seen.
export function groupTiles(words, read = () => true) {
  if (!words.length) return [];
  const h = median(words.map((w) => w.y1 - w.y0)) || 10;
  const parent = words.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (a, b) => (parent[find(a)] = find(b));
  const counts = words.map((w) => countOf(w) != null);

  for (let i = 0; i < words.length; i++) {
    if (counts[i]) continue;
    for (let j = i + 1; j < words.length; j++) {
      if (counts[j]) continue;
      const a = words[i];
      const b = words[j];
      const overlapY = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      const gapX = Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1);
      if (overlapY > 0.5 * Math.min(a.y1 - a.y0, b.y1 - b.y0)) {
        if (gapX < 0.9 * h) join(i, j);
        continue;
      }
      const [top, bottom] = a.y0 < b.y0 ? [a, b] : [b, a];
      const gapY = bottom.y0 - top.y1;
      const dx = Math.abs((a.x0 + a.x1) / 2 - (b.x0 + b.x1) / 2);
      if (gapY > -0.3 * h && gapY < 0.8 * h && (dx < Math.max(a.x1 - a.x0, b.x1 - b.x0) / 2 + h || gapX < 0)) join(i, j);
    }
  }

  const groups = new Map();
  words.forEach((w, i) => {
    if (counts[i]) return;
    const k = find(i);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(w);
  });
  const tiles = [...groups.values()].map((ws) => {
    // Reading order: line by line, left to right. A word joins a line when its vertical centre is
    // close to the line's, so a taller box such as "M1" stays on the line it belongs to.
    const lines = [];
    for (const w of [...ws].sort((a, b) => a.y0 + a.y1 - (b.y0 + b.y1))) {
      const cy = (w.y0 + w.y1) / 2;
      const line = lines.find((l) => Math.abs(l.cy - cy) < 0.6 * h);
      if (line) line.words.push(w);
      else lines.push({ cy, words: [w] });
    }
    const ordered = lines.flatMap((l) => l.words.sort((a, b) => a.x0 - b.x0));
    return {
      text: ordered.map((w) => w.text).join(' '),
      conf: Math.min(...ws.map((w) => w.conf ?? 100)),
      qty: null,
      x0: Math.min(...ws.map((w) => w.x0)),
      x1: Math.max(...ws.map((w) => w.x1)),
      y0: Math.min(...ws.map((w) => w.y0)),
      y1: Math.max(...ws.map((w) => w.y1)),
    };
  });
  for (const t of tiles) t.hit = read(t) || null;

  words.forEach((w, i) => {
    if (!counts[i]) return;
    const cx = (w.x0 + w.x1) / 2;
    let best = null;
    let bestD = Infinity;
    for (const t of tiles) {
      if (!t.hit || t.qty != null || t.y1 < w.y0 - h) continue; // only names below or level with the number
      // The count sits in the top left corner of its own tile, so it is left of the name's centre
      // but never past it: this keeps a neighbour's count from landing on a tile without one.
      const tw = t.x1 - t.x0;
      const off = cx - (t.x0 + t.x1) / 2;
      if (off > 0.3 * tw || off < -(tw / 2 + 4 * h)) continue;
      const dx = cx < t.x0 ? t.x0 - cx : cx > t.x1 ? cx - t.x1 : 0;
      const dy = Math.max(0, t.y0 - w.y1);
      if (dx > 6 * h || dy > 10 * h) continue;
      const d = dx + dy;
      if (d < bestD) [best, bestD] = [t, d];
    }
    if (best) best.qty = countOf(w);
  });

  return tiles;
}

// Combines the passes over one screenshot. read(tile) returns { key, ...item } or null.
// All passes look at the same pixels, so tiles are matched up by position and each spot on screen
// takes the item most passes agree on (a single pass misreading "Neo O2" as "Neo O3" is outvoted).
// The quantity is the count most of those passes saw, 1 when none saw one.
// Text no pass could match, at a spot where no item was found, comes back as unread.
const overlap = (a, b) => {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0));
};

export function combinePasses(passes, read) {
  const spots = [];
  const unread = [];
  passes.forEach((words, k) => {
    for (const tile of groupTiles(dropRewardPanel(words), read)) {
      if (!tile.hit) {
        if (k === 0) unread.push(tile);
        continue;
      }
      // Same spot when the boxes overlap enough: icon junk can stretch one pass's box upwards.
      let spot = spots.find((s) => overlap(s, tile) > 0.3);
      if (!spot) spots.push((spot = { x0: tile.x0, y0: tile.y0, x1: tile.x1, y1: tile.y1, reads: [] }));
      spot.reads.push({ ...tile.hit, qty: tile.qty, read: tile.text, conf: tile.conf, box: { x0: tile.x0, y0: tile.y0, x1: tile.x1, y1: tile.y1 } });
    }
  });
  const items = new Map();
  const area = (b) => (b.x1 - b.x0) * (b.y1 - b.y0);
  for (const { reads } of spots) {
    const tally = (xs) => {
      const m = new Map();
      for (const x of xs) if (x != null) m.set(x, (m.get(x) ?? 0) + 1);
      return [...m].sort((a, b) => b[1] - a[1])[0]?.[0];
    };
    const key = tally(reads.map((r) => r.key));
    const mine = reads.filter((r) => r.key === key);
    // The tightest box is the cleanest read of the name, without junk picked up from the icon art.
    const box = mine.reduce((a, r) => (area(r.box) < area(a) ? r.box : a), mine[0].box);
    // Unsure when the passes disagreed on this spot or only one pass could read it.
    // With a single pass, the engine's own confidence decides instead.
    const sure = passes.length > 1 ? mine.length >= 2 && mine.length === reads.length : mine[0].conf >= 90;
    const item = { ...mine[0], qty: tally(mine.map((r) => r.qty)) ?? 1, box, votes: mine.length, sure };
    // One tile per item on a screen: if a name shows up at two spots, trust the better supported one.
    const prev = items.get(key);
    if (!prev || prev.votes < item.votes || (prev.votes === item.votes && prev.qty < item.qty)) items.set(key, item);
  }
  const inSpot = (t) => spots.some((s) => t.x0 < s.x1 && t.x1 > s.x0 && t.y0 < s.y1 && t.y1 > s.y0);
  return { items: [...items.values()], unread: [...new Set(unread.filter((t) => !inSpot(t)).map((t) => t.text))] };
}

// Characters OCR mixes up in this font cost less to swap, so "LITH 61" lands on "Lith G1".
const CONFUSED = new Set(['0o', '1i', '1l', 'il', '5s', '8b', '6g', '2z', 'cg', 'uv', 'nm', 'ec', 'ao', '1t', '1j'].flatMap((p) => [p, p[1] + p[0]]));
const subCost = (a, b) => (a === b ? 0 : CONFUSED.has(a + b) ? 0.3 : 1);

function distance(a, b, limit) {
  let prev = new Float32Array(b.length + 1).map((_, j) => j);
  let cur = new Float32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + subCost(a[i - 1], b[j - 1]));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > limit) return Infinity;
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

// keys: [{ key: normalised text, value }]. Returns the value whose key is closest to text,
// or null when nothing is close enough or two different values are about as close.
export function createFuzzy(keys) {
  return (text, maxRatio = 0.2) => {
    if (!text) return null;
    const limit = Math.max(1, text.length * maxRatio);
    let best = null;
    let bestD = Infinity;
    let runnerD = Infinity;
    for (const { key, value } of keys) {
      if (Math.abs(key.length - text.length) > limit) continue;
      const d = distance(text, key, Math.min(limit, runnerD));
      if (d < bestD) {
        if (best !== value) runnerD = bestD;
        [best, bestD] = [value, d];
      } else if (d < runnerD && value !== best) runnerD = d;
    }
    if (bestD > 0 && (bestD > limit || runnerD - bestD < 0.5)) return null;
    return best;
  };
}
