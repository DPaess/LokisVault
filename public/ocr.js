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

// Game text is light on a dark background. Tesseract reads dark on light best, so scale the
// image up, make it grey, invert it when it is mostly dark and stretch the contrast.
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
  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;
  const grey = new Uint8ClampedArray(w * h);
  let total = 0;
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    // Max channel instead of luminance keeps gold and blue UI text as bright as white text.
    grey[j] = Math.max(px[i], px[i + 1], px[i + 2]);
    total += grey[j];
  }
  const invert = total / grey.length < 128;
  const hist = new Uint32Array(256);
  for (const g of grey) hist[invert ? 255 - g : g]++;
  const pick = (q) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) if ((acc += hist[v]) >= q * grey.length) return v;
    return 255;
  };
  const lo = pick(0.02);
  const hi = Math.max(lo + 1, pick(0.98));
  for (let j = 0; j < grey.length; j++) {
    const g = invert ? 255 - grey[j] : grey[j];
    const v = ((g - lo) * 255) / (hi - lo);
    px[j * 4] = px[j * 4 + 1] = px[j * 4 + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// Returns the words found in each image with their boxes, one array per image.
export async function readImages(blobs, onProgress = () => {}) {
  const T = await loadEngine();
  let current = 0;
  const worker = await T.createWorker('eng', 1, {
    logger: (m) => {
      if (m.status === 'recognizing text') onProgress(`Reading image ${current + 1} of ${blobs.length}… ${Math.round(m.progress * 100)}%`);
      else if (m.status) onProgress(`${m.status[0].toUpperCase()}${m.status.slice(1)}…`);
    },
  });
  try {
    // Sparse text: item names are scattered labels, not paragraphs.
    await worker.setParameters({ tessedit_pageseg_mode: '11' });
    const out = [];
    for (; current < blobs.length; current++) {
      onProgress(`Preparing image ${current + 1} of ${blobs.length}…`);
      const { data } = await worker.recognize(await prepareImage(blobs[current]));
      out.push(
        (data.words ?? [])
          .filter((w) => w.confidence >= 20 && /[a-z0-9]/i.test(w.text))
          .map((w) => ({ text: w.text, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 })),
      );
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
const isCount = (t) => /^[x×]?\d{1,4}[x×]?$/i.test(t);

// Groups words into tiles: words on one line close together, plus lines just below them that
// are roughly centred under them (inventory names wrap onto two or three lines).
// Lone numbers become the quantity of the nearest name below or beside them.
// Returns [{ text, qty }] with qty null when no count was seen.
export function groupTiles(words) {
  if (!words.length) return [];
  const h = median(words.map((w) => w.y1 - w.y0)) || 10;
  const parent = words.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (a, b) => (parent[find(a)] = find(b));
  const counts = words.map((w) => isCount(w.text));

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
    // Reading order: line by line, left to right.
    ws.sort((a, b) => (Math.abs(a.y0 - b.y0) < 0.5 * h ? a.x0 - b.x0 : a.y0 - b.y0));
    return {
      text: ws.map((w) => w.text).join(' '),
      qty: null,
      x0: Math.min(...ws.map((w) => w.x0)),
      x1: Math.max(...ws.map((w) => w.x1)),
      y0: Math.min(...ws.map((w) => w.y0)),
      y1: Math.max(...ws.map((w) => w.y1)),
    };
  });

  words.forEach((w, i) => {
    if (!counts[i]) return;
    const cx = (w.x0 + w.x1) / 2;
    let best = null;
    let bestD = Infinity;
    for (const t of tiles) {
      if (t.qty != null || t.y1 < w.y0 - h) continue; // only names below or level with the number
      const dx = cx < t.x0 ? t.x0 - cx : cx > t.x1 ? cx - t.x1 : 0;
      const dy = Math.max(0, t.y0 - w.y1);
      if (dx > 6 * h || dy > 10 * h) continue;
      const d = dx + dy;
      if (d < bestD) [best, bestD] = [t, d];
    }
    if (best) best.qty = Number(w.text.replace(/[x×]/gi, ''));
  });

  return tiles.map(({ text, qty }) => ({ text, qty }));
}

// Characters OCR mixes up in this font cost less to swap, so "LITH 61" lands on "Lith G1".
const CONFUSED = new Set(['0o', '1i', '1l', 'il', '5s', '8b', '6g', '2z', 'cg', 'uv', 'nm', 'ec', 'ao'].flatMap((p) => [p, p[1] + p[0]]));
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
    if (bestD > limit || runnerD - bestD < 0.5) return null;
    return best;
  };
}
