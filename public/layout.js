// Finds the tile grid of an inventory screen from the image itself, so each tile's name and count
// can be read on their own instead of reading the whole screenshot at once. The approach (read
// known regions, not the whole screen) is the one WFInfo uses for the reward screen; this is an
// independent implementation that detects the regions instead of assuming a resolution.

// Tile frames are thin lines slightly brighter than the pixels around them. Summed along each column
// (and row) they make sharp peaks, while text and icons do not line up over a whole tile edge.
function edgeProfile(v, w, h, vertical) {
  const along = vertical ? h : w;
  const across = vertical ? w : h;
  const at = vertical ? (a, b) => v[b * w + a] : (a, b) => v[a * w + b];
  const out = new Float32Array(across);
  for (let a = 3; a < across - 3; a++) {
    let n = 0;
    for (let b = 0; b < along; b++) {
      const c = at(a, b);
      if (c < 120 && c - at(a - 3, b) > 6 && c - at(a + 3, b) > 6) n++;
    }
    out[a] = n;
  }
  return out;
}

function peaks(profile, min) {
  const out = [];
  for (let i = 2; i < profile.length - 2; i++) {
    const p = profile[i];
    if (p > min && p >= profile[i - 1] && p >= profile[i + 1] && p >= profile[i - 2] && p >= profile[i + 2]) out.push(i);
  }
  return out;
}

// Gaps between frame lines come in two sizes: the tile itself and the pitch (one tile plus the
// space before the next). The pitch is usually the most common gap, the tile the most common
// clearly smaller one.
function gapSizes(lines) {
  const votes = new Map();
  for (let i = 0; i < lines.length; i++)
    for (let j = i + 1; j < lines.length; j++) {
      const d = lines[j] - lines[i];
      if (d < 60 || d > 400) continue;
      for (const k of [d - 1, d, d + 1]) votes.set(k, (votes.get(k) ?? 0) + (k === d ? 2 : 1));
    }
  const ranked = [...votes].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return null;
  const pitch = ranked[0][0];
  const smaller = ranked.find(([d, n]) => d < pitch * 0.92 && d > pitch * 0.5 && n >= ranked[0][1] * 0.3);
  return { size: smaller ? smaller[0] : pitch, pitch };
}

// Starts of tiles along one axis: lines with a partner one tile size further, kept only when they
// sit on one evenly spaced run (that drops side panels and stray text lines), with holes in the run
// filled in where a busy background hid an edge.
function tileStarts(lines, size, limit) {
  const starts = lines.filter((a) => lines.some((b) => Math.abs(b - a - size) <= 3));
  let best = null;
  for (let i = 0; i < starts.length; i++)
    for (let j = i + 1; j < starts.length; j++) {
      const pitch = starts[j] - starts[i];
      if (pitch < size || pitch > size * 1.6) continue;
      const on = starts.filter((a) => {
        const k = Math.round((a - starts[i]) / pitch);
        return Math.abs(a - (starts[i] + k * pitch)) <= 4;
      });
      if (!best || on.length > best.on.length || (on.length === best.on.length && pitch < best.pitch)) best = { pitch, on, origin: starts[i] };
    }
  if (!best || best.on.length < 2) return [];
  const first = Math.min(...best.on);
  const last = Math.max(...best.on);
  const out = [];
  for (let a = first; a <= last + 1 && a + size <= limit; a += best.pitch) out.push(Math.round(best.on.find((x) => Math.abs(x - a) <= 4) ?? a));
  return out;
}

// Is there a thin bright vertical line at (x ± 1, y)?
function edgeAt(v, w, x, y) {
  for (let dx = -1; dx <= 1; dx++) {
    const c = v[y * w + x + dx];
    if (c < 120 && c - v[y * w + x + dx - 3] > 6 && c - v[y * w + x + dx + 3] > 6) return true;
  }
  return false;
}

// Tiles in one column: stretches where the column's left or right frame edge runs for about one
// tile height. Following the vertical edges is more reliable than looking for horizontal lines,
// which lines of text imitate.
function tilesInColumn(v, w, h, x0, size) {
  const on = new Uint8Array(h);
  for (let y = 0; y < h; y++) on[y] = edgeAt(v, w, x0, y) || edgeAt(v, w, x0 + size, y) ? 1 : 0;
  // Close small breaks in the edge (a bright icon touching the frame, compression noise).
  for (let y = 0, gap = 0; y < h; y++) {
    if (on[y]) {
      if (gap > 0 && gap <= 8) for (let k = y - gap; k < y; k++) on[k] = 1;
      gap = 0;
    } else gap++;
  }
  const out = [];
  for (let y = 0; y < h; ) {
    if (!on[y]) {
      y++;
      continue;
    }
    let end = y;
    while (end < h && on[end]) end++;
    const len = end - y;
    // One tile, or several stacked with no gap: split into tiles of the known size.
    if (len >= size * 0.85) for (let k = 0; k < Math.round(len / size); k++) out.push({ x0, y0: y + k * Math.round(len / Math.round(len / size)), x1: x0 + size });
    y = end;
  }
  for (const t of out) t.y1 = t.y0 + size;
  return out.filter((t) => t.y1 <= h);
}

// v: brightness (max of r, g, b) per pixel. Returns [{ x0, y0, x1, y1 }] for every whole tile.
export function findTiles(v, w, h) {
  const colLines = peaks(edgeProfile(v, w, h, true), h * 0.12);
  const gaps = gapSizes(colLines);
  if (!gaps) return [];
  const size = gaps.size;
  const xs = tileStarts(colLines, size, w);
  if (xs.length < 2) return [];
  // Rows line up across columns: group the tile tops found per column, take each group's median,
  // then fill rows a column missed (a faint frame) using the row pitch.
  const tops = xs.flatMap((x0) => tilesInColumn(v, w, h, x0, size).map((t) => t.y0)).sort((a, b) => a - b);
  const groups = [];
  for (const y of tops) {
    const g = groups.find((gr) => Math.abs(gr[0] - y) <= 14);
    if (g) g.push(y);
    else groups.push([y]);
  }
  // Rows seen by two or more columns; on screens of mostly greyed tiles, single sightings too.
  let rows = groups.filter((g) => g.length >= 2);
  if (rows.length < 2) rows = groups;
  rows = rows.map((g) => g[g.length >> 1]).sort((a, b) => a - b);
  if (!rows.length) return [];
  const diffs = rows.slice(1).map((y, i) => y - rows[i]).filter((d) => d >= size && d <= size * 1.7);
  const pitch = diffs.length ? diffs.sort((a, b) => a - b)[diffs.length >> 1] : null;
  const all = new Set(rows);
  if (pitch)
    for (const r of rows) {
      for (let y = r - pitch; y >= 0; y -= pitch) all.add(y);
      for (let y = r + pitch; y + size <= h; y += pitch) all.add(y);
    }
  const cover = (x0, y0) => Math.max(edgeCoverAt(v, w, x0, y0, y0 + size), edgeCoverAt(v, w, x0 + size, y0, y0 + size));
  const kept = [...all].filter((y0) => rows.includes(y0) || xs.reduce((n, x0) => n + cover(x0, y0), 0) / xs.length >= 0.15);
  // Snap each row to the strongest horizontal frame line near it: names touch the bottom edge,
  // so a row that is a few pixels off would cut them.
  const snap = (y0) => {
    let best = y0;
    let bestN = -1;
    for (let y = Math.max(3, y0 - 16); y <= Math.min(h - size - 4, y0 + 16); y++) {
      let n = 0;
      for (const x0 of xs)
        for (let x = x0 + 4; x < x0 + size - 4; x++) {
          const c = v[y * w + x];
          if (c < 120 && c - v[(y - 3) * w + x] > 6 && c - v[(y + 3) * w + x] > 6) n++;
        }
      if (n > bestN) [best, bestN] = [y, n];
    }
    return best;
  };
  // Merge fills that landed on a found row.
  const final = kept
    .map(snap)
    .sort((a, b) => a - b)
    .filter((y, i, arr) => i === 0 || y - arr[i - 1] > size * 0.5);
  return final.flatMap((y0) => xs.map((x0) => ({ x0, y0, x1: x0 + size, y1: y0 + size })));
}

function edgeCoverAt(v, w, x, y0, y1) {
  let n = 0;
  for (let y = y0; y < y1; y++) if (edgeAt(v, w, x, y)) n++;
  return n / Math.max(1, y1 - y0);
}

// The parts of a tile worth reading, relative to its size: the name along the bottom (it can run a
// little past the frame), the stack count in the top left corner, and the icon in the middle.
export function tileRegions(t) {
  const s = t.x1 - t.x0;
  const r = (x0, y0, x1, y1) => ({ x0: Math.round(x0), y0: Math.round(y0), x1: Math.round(x1), y1: Math.round(y1) });
  return {
    name: r(t.x0 - 0.04 * s, t.y0 + 0.6 * s, t.x1 + 0.04 * s, t.y1 + 0.1 * s),
    count: r(t.x0 + 0.01 * s, t.y0 + 0.01 * s, t.x0 + 0.45 * s, t.y0 + 0.24 * s),
    icon: r(t.x0 + 0.2 * s, t.y0 + 0.15 * s, t.x1 - 0.2 * s, t.y0 + 0.6 * s),
  };
}

// Share of bright pixels in a region of the brightness channel: owned relic icons are lit,
// relics you do not own are greyed out.
export function lightIn(v, w, { x0, y0, x1, y1 }) {
  let lit = 0;
  let all = 0;
  for (let y = Math.max(0, y0); y < y1; y++)
    for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) {
      all++;
      if (v[y * w + x] >= 150) lit++;
    }
  return all ? lit / all : 0;
}

// Cuts a region out as black text on white, scaled up for the reader. Text is whatever the minority
// side of the region's own best split is, which works for light names on dark tiles and for the
// dark labels on light bands alike. Uses the darkest colour channel so gold icon edges fall away.
// rgba: the full screenshot (4 bytes per pixel). Returns { width, height, data } as RGBA.
export function textCrop(rgba, w, h, reg, scale = 3) {
  const x0 = Math.max(0, reg.x0);
  const y0 = Math.max(0, reg.y0);
  const x1 = Math.min(w, reg.x1);
  const y1 = Math.min(h, reg.y1);
  const cw = x1 - x0;
  const ch = y1 - y0;
  const g = new Uint8Array(cw * ch);
  const hist = new Uint32Array(256);
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      const i = ((y0 + y) * w + x0 + x) * 4;
      const m = Math.min(rgba[i], rgba[i + 1], rgba[i + 2]);
      g[y * cw + x] = m;
      hist[m]++;
    }
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = -1;
  let cut = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = g.length - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const between = wB * wF * (sumB / wB - (sumAll - sumB) / wF) ** 2;
    if (between > best) [best, cut] = [between, i];
  }
  let above = 0;
  for (const p of g) if (p > cut) above++;
  const lightText = above <= g.length / 2;
  const W = cw * scale;
  const H = ch * scale;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const p = g[Math.floor(y / scale) * cw + Math.floor(x / scale)];
      const text = lightText ? p > cut : p <= cut;
      const o = (y * W + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = text ? 0 : 255;
      data[o + 3] = 255;
    }
  return { width: W, height: H, data };
}
