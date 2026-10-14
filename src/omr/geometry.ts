// Fermata's own page reader: finds the staves, bar lines and lines of music (systems) on a
// photo or scan. It doesn't read notes (the AI does that); it gives the page's shape, so
// we can light up bars on your own page and tell the AI exactly how many bars to read.
// Pure TypeScript, no DOM: runs in the browser (phones) and in Node (tests).

import { dewarp } from "./dewarp.ts";

export interface Staff {
  /** y of the top and bottom staff lines. */
  top: number;
  bottom: number;
  /** Distance between staff lines. */
  space: number;
  left: number;
  right: number;
  /** y of each of the five lines. */
  lines: number[];
}

export interface SystemGeom {
  top: number;
  bottom: number;
  staves: Staff[];
  /** x of each bar line (including the system's opening line if there is one). */
  barlines: number[];
  /** Bars as [left, right] spans. */
  bars: [number, number][];
}

export interface PageGeometry {
  width: number;
  height: number;
  /** The cleaned, straightened page (0 = black, 255 = white). */
  pixels: Uint8Array;
  systems: SystemGeom[];
  /** Staff-line spacing (px), the page's basic unit. */
  space: number;
  /** How much the page had to be straightened (px). */
  bend: number;
}

/** Long side of the working image. Big enough for thin lines, small enough for phones. */
export const WORK_SIZE = 2000;

// ---------- 1. black & white ----------

/**
 * Turns a grayscale photo into clean black & white. Uses the local average brightness, so
 * shadows and uneven lighting on phone photos don't turn whole regions black.
 */
export function binarize(gray: Uint8Array, w: number, h: number): Uint8Array {
  // Integral image for fast local means.
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += gray[y * w + x];
      integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + row;
    }
  }
  // Global (Otsu) threshold as a ceiling: nothing lighter than the paper counts as ink.
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const otsu = otsuThreshold(hist, gray.length);

  const r = Math.max(8, Math.round(Math.max(w, h) / 50));
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const sum = integral[y1 * (w + 1) + x1] - integral[y0 * (w + 1) + x1] - integral[y1 * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
      const mean = sum / ((x1 - x0) * (y1 - y0));
      const v = gray[y * w + x];
      out[y * w + x] = v < mean * 0.86 && v < otsu + 30 ? 0 : 255;
    }
  }
  return out;
}

function otsuThreshold(hist: Uint32Array, total: number): number {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

// ---------- 2. staff lines ----------

interface LineRow {
  y: number;
  thickness: number;
  left: number;
  right: number;
  length: number;
}

/** Rows that contain one long, nearly unbroken horizontal run of ink. */
function findLineRows(bw: Uint8Array, w: number, h: number): LineRow[] {
  const minRun = w * 0.22;
  const rows: { y: number; left: number; right: number; length: number }[] = [];
  for (let y = 0; y < h; y++) {
    const off = y * w;
    let best = { left: 0, right: 0, length: 0 };
    let start = -1;
    let gap = 0;
    let ink = 0;
    for (let x = 0; x < w; x++) {
      if (bw[off + x] === 0) {
        if (start < 0) start = x;
        gap = 0;
        ink++;
      } else if (start >= 0) {
        // Allow tiny breaks (photo noise, thin print).
        if (++gap > 3) {
          const len = x - gap - start;
          if (len > best.length) best = { left: start, right: x - gap, length: ink };
          start = -1;
          gap = 0;
          ink = 0;
        }
      }
    }
    if (start >= 0) {
      const len = w - gap - start;
      if (len > best.length) best = { left: start, right: w - gap, length: ink };
    }
    if (best.length >= minRun) rows.push({ y, ...best });
  }
  // Merge neighbouring rows (a line can be several pixels thick).
  const lines: LineRow[] = [];
  for (const r of rows) {
    const last = lines[lines.length - 1];
    if (last && r.y - (last.y + last.thickness / 2) <= 1.5) {
      const n = last.thickness + 1;
      last.y = (last.y * last.thickness + r.y) / n;
      last.thickness = n;
      last.left = Math.min(last.left, r.left);
      last.right = Math.max(last.right, r.right);
      last.length = Math.max(last.length, r.length);
    } else lines.push({ y: r.y, thickness: 1, left: r.left, right: r.right, length: r.length });
  }
  return lines.filter((l) => l.thickness <= 8);
}

/** Five evenly spaced lines make a staff. */
function groupStaves(lines: LineRow[]): Staff[] {
  const staves: Staff[] = [];
  let i = 0;
  while (i + 4 < lines.length) {
    const five = lines.slice(i, i + 5);
    const gaps = five.slice(1).map((l, k) => l.y - five[k].y);
    const mean = gaps.reduce((a, b) => a + b, 0) / 4;
    const even = gaps.every((g) => Math.abs(g - mean) <= Math.max(2, mean * 0.22));
    if (even && mean >= 5) {
      staves.push({
        top: five[0].y,
        bottom: five[4].y,
        space: mean,
        left: median(five.map((l) => l.left)),
        right: median(five.map((l) => l.right)),
        lines: five.map((l) => l.y),
      });
      i += 5;
    } else i++;
  }
  return staves;
}

// ---------- 3. bar lines ----------

/** Width of the horizontal ink run through (x, y), looking up to `limit` px each way. */
function runWidth(bw: Uint8Array, w: number, x: number, y: number, limit: number): number {
  const off = Math.round(y) * w;
  let a = x;
  let b = x;
  while (a > 0 && x - a < limit && bw[off + a - 1] === 0) a--;
  while (b < w - 1 && b - x < limit && bw[off + b + 1] === 0) b++;
  return bw[off + x] === 0 ? b - a + 1 : 0;
}

/**
 * A stem has a notehead at one end; a bar line is equally thin all the way down.
 * Measures the ink width in the middle of each of the four staff spaces.
 */
function looksLikeStem(bw: Uint8Array, w: number, x: number, staff: Staff, strokeWidth: number): boolean {
  const s = staff.space;
  const allowed = strokeWidth + Math.max(2, s * 0.35);
  for (let k = 0; k < 4; k++) {
    const yMid = (staff.lines[k] + staff.lines[k + 1]) / 2;
    // Check a few rows across the space (a notehead fills most of it).
    for (const dy of [-s * 0.2, 0, s * 0.2]) {
      // Look at both sides of the stroke (stems sit on either side of their notehead).
      const widest = Math.max(runWidth(bw, w, Math.round(x), yMid + dy, Math.ceil(s * 1.6)), runWidth(bw, w, Math.round(x) - 1, yMid + dy, Math.ceil(s * 1.6)));
      if (widest > allowed) return true;
    }
  }
  return false;
}

/** Fraction of ink in a column between two heights (checks the column and its neighbour). */
function inkFraction(bw: Uint8Array, w: number, x: number, y0: number, y1: number): number {
  const a = Math.max(0, Math.round(y0));
  const b = Math.round(y1);
  if (b <= a) return 0;
  let ink = 0;
  for (let y = a; y <= b; y++) if (bw[y * w + x] === 0 || (x + 1 < w && bw[y * w + x + 1] === 0)) ink++;
  return ink / (b - a + 1);
}

/**
 * Does a stroke at x run all the way down to y1? Follows it as it drifts sideways
 * (photos are rarely perfectly straight), allowing a pixel of drift per few rows.
 */
function joinsDown(bw: Uint8Array, w: number, x: number, y0: number, y1: number): boolean {
  let cx = x;
  let misses = 0;
  const total = Math.max(1, Math.round(y1) - Math.round(y0));
  for (let y = Math.round(y0); y <= Math.round(y1); y++) {
    const off = y * w;
    let hit = -1;
    for (const d of [0, -1, 1, -2, 2]) {
      const xx = cx + d;
      if (xx >= 0 && xx < w && bw[off + xx] === 0) {
        hit = xx;
        break;
      }
    }
    if (hit < 0) {
      if (++misses > total * 0.08) return false;
    } else cx = hit;
  }
  return true;
}

/**
 * Bar lines in one staff: thin vertical strokes that run the full height of the staff and
 * (unlike note stems) stop at its edges. Lines continuing into the next staff are kept and
 * marked, since that's how staves of one system are tied together.
 */
function findBarlines(bw: Uint8Array, w: number, staff: Staff, below: Staff | null): { x: number; joinsNext: boolean }[] {
  const s = staff.space;
  const found: { x0: number; x1: number; joins: boolean }[] = [];
  for (let x = Math.max(0, Math.round(staff.left - s)); x <= Math.min(w - 2, Math.round(staff.right + s)); x++) {
    if (inkFraction(bw, w, x, staff.top + 1, staff.bottom - 1) < 0.94) continue;
    // A stem sticks out above or below the staff; a bar line doesn't…
    const above = inkFraction(bw, w, x, staff.top - s * 1.6, staff.top - s * 0.5);
    const under = inkFraction(bw, w, x, staff.bottom + s * 0.5, staff.bottom + s * 1.6);
    // …unless it carries on down into the next staff of the same system.
    const joins = !!below && joinsDown(bw, w, x, staff.bottom, below.top);
    if (above > 0.5 || (under > 0.5 && !joins)) continue;
    const last = found[found.length - 1];
    if (last && x - last.x1 <= 1) {
      last.x1 = x;
      last.joins ||= joins;
    } else found.push({ x0: x, x1: x, joins });
  }
  // Thin (normal) or thick (final/repeat) strokes only; wider blobs are noteheads or text.
  // And no notehead attached anywhere along it (that's a stem).
  return found
    .filter((b) => b.x1 - b.x0 + 1 <= Math.max(3, s * 0.9))
    .filter((b) => !looksLikeStem(bw, w, (b.x0 + b.x1) / 2, staff, b.x1 - b.x0 + 1))
    .map((b) => ({ x: (b.x0 + b.x1) / 2, joinsNext: b.joins }));
}

/**
 * The line (and bracket) at the very start of a system ties its staves together, even in
 * vocal scores where the bar lines stop at each staff. Looks a little either side of where
 * the staves begin, for a stroke running from this staff down into the next.
 */
function connectedAtLeft(bw: Uint8Array, w: number, staff: Staff, below: Staff): boolean {
  const s = staff.space;
  const from = Math.max(0, Math.round(Math.min(staff.left, below.left) - s * 2.5));
  const to = Math.min(w - 1, Math.round(Math.max(staff.left, below.left) + s * 1.5));
  for (let x = from; x <= to; x++) {
    if (inkFraction(bw, w, x, staff.top + 1, staff.bottom - 1) < 0.85) continue;
    if (joinsDown(bw, w, x, staff.top, below.bottom)) return true;
  }
  return false;
}

// ---------- 4. the whole page ----------

/**
 * Reads the shape of a page: straightens it, then finds staves, systems and bars.
 * `gray` is width×height 8-bit grayscale, ideally about WORK_SIZE on the long side.
 */
export function analyzePage(gray: Uint8Array, width: number, height: number): PageGeometry {
  const bw0 = binarize(gray, width, height);
  const { pixels: bw, maxShift } = dewarp(bw0, width, height);
  // dewarp works on gray; re-threshold its interpolated output.
  for (let i = 0; i < bw.length; i++) bw[i] = bw[i] < 128 ? 0 : 255;

  const staves = groupStaves(findLineRows(bw, width, height));
  const space = staves.length ? median(staves.map((s) => s.space)) : 0;

  // Bar lines per staff, and which staves are joined into systems.
  const perStaff = staves.map((st, i) => findBarlines(bw, width, st, staves[i + 1] ?? null));
  const systems: SystemGeom[] = [];
  let current: Staff[] = [];
  let lines: number[][] = [];
  staves.forEach((st, i) => {
    current.push(st);
    lines.push(perStaff[i].map((b) => b.x));
    const next = staves[i + 1];
    const joined = !!next && next.top - st.bottom < st.space * 12 && (perStaff[i].some((b) => b.joinsNext) || connectedAtLeft(bw, width, st, next));
    if (!joined) {
      systems.push(buildSystem(current, lines, space));
      current = [];
      lines = [];
    }
  });

  return { width, height, pixels: bw, systems: systems.filter((s) => s.bars.length > 0), space, bend: Math.round(maxShift) };
}

function buildSystem(staves: Staff[], perStaff: number[][], space: number): SystemGeom {
  const left = Math.min(...staves.map((s) => s.left));
  const right = Math.max(...staves.map((s) => s.right));
  // A bar line counts if most staves of the system agree on it (multi-staff), or it's there (single).
  const all = perStaff.flat().sort((a, b) => a - b);
  const clusters: number[][] = [];
  for (const x of all) {
    const last = clusters[clusters.length - 1];
    if (last && x - last[last.length - 1] <= space * 0.6) last.push(x);
    else clusters.push([x]);
  }
  const needed = staves.length > 1 ? Math.ceil(staves.length / 2) : 1;
  let xs = clusters.filter((c) => c.length >= needed).map((c) => median(c));
  // Double bar lines → one.
  xs = xs.filter((x, i) => i === 0 || x - xs[i - 1] > space * 1.4);

  const edges = [...xs];
  if (!edges.length || edges[0] - left > space * 2.5) edges.unshift(left);
  if (right - edges[edges.length - 1] > space * 3) edges.push(right);
  const bars: [number, number][] = [];
  for (let i = 0; i + 1 < edges.length; i++) if (edges[i + 1] - edges[i] > space * 2.2) bars.push([edges[i], edges[i + 1]]);
  return { top: staves[0].top, bottom: staves[staves.length - 1].bottom, staves, barlines: xs, bars };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
}

/** Short description for the AI: how many lines and bars the page has. */
export function describeForAI(geom: PageGeometry): string {
  if (!geom.systems.length) return "";
  const lines = geom.systems.map((s, i) => `line ${i + 1}: ${s.staves.length} staff${s.staves.length > 1 ? "s" : ""}, ${s.bars.length} bar${s.bars.length > 1 ? "s" : ""}`);
  const total = geom.systems.reduce((n, s) => n + s.bars.length, 0);
  return `Fermata's page detector found ${geom.systems.length} lines of music and about ${total} bars (a multi-bar rest counts as one box here):\n${lines.join("\n")}\nRead every one of these lines, in order. Staves on the same line play together.`;
}

// ---------- 5. noteheads ----------

export interface Notehead {
  x: number;
  y: number;
  /** Staff position: 0 = bottom line, 1 = first space, 2 = second line … (negative = below). */
  step: number;
  /** Index of the staff (in page order). */
  staff: number;
  filled: boolean;
  /** Bounding box half-size. */
  rx: number;
  ry: number;
}

/**
 * Finds filled noteheads on one staff (and its ledger-line area). Staff lines are erased
 * only where they're thin (so heads on lines survive); then a distance transform keeps only
 * solid blobs. Stems, beams, ties and most text are thin and disappear.
 */
export function findNoteheads(bw: Uint8Array, w: number, h: number, staff: Staff, staffIndex: number, yMin: number, yMax: number): Notehead[] {
  const s = staff.space;
  const y0 = Math.max(0, Math.round(Math.max(yMin, staff.top - s * 3.5)));
  const y1 = Math.min(h - 1, Math.round(Math.min(yMax, staff.bottom + s * 3.5)));
  const x0 = Math.max(0, Math.round(staff.left - s));
  const x1 = Math.min(w - 1, Math.round(staff.right + s));
  const bw2 = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  const ink = new Uint8Array(bw2 * bh);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw2; x++) ink[y * bw2 + x] = bw[(y + y0) * w + x + x0] === 0 ? 1 : 0;

  // Erase staff lines and ledger-line positions where the ink is only line-thick.
  const thick = Math.max(2, Math.round(s * 0.18));
  const linesY = [...staff.lines];
  for (let k = 1; k <= 3; k++) linesY.push(staff.top - k * s, staff.bottom + k * s);
  for (const ly of linesY) {
    const cy = Math.round(ly) - y0;
    for (let x = 0; x < bw2; x++) {
      // Vertical run through this line at x.
      let a = cy;
      let b = cy;
      if (cy < 0 || cy >= bh) continue;
      if (!ink[cy * bw2 + x]) {
        // the line may sit a pixel off: look around
        let found = -1;
        for (const d of [-1, 1, -2, 2]) if (cy + d >= 0 && cy + d < bh && ink[(cy + d) * bw2 + x]) found = cy + d;
        if (found < 0) continue;
        a = b = found;
      }
      while (a > 0 && ink[(a - 1) * bw2 + x]) a--;
      while (b < bh - 1 && ink[(b + 1) * bw2 + x]) b++;
      if (b - a + 1 <= thick + 1) for (let y = a; y <= b; y++) ink[y * bw2 + x] = 0;
    }
  }

  // Chamfer (3-4) distance transform: distance (×3) from each ink pixel to the nearest white.
  const dist = new Uint16Array(bw2 * bh);
  const BIG = 60000;
  for (let i = 0; i < dist.length; i++) dist[i] = ink[i] ? BIG : 0;
  for (let y = 0; y < bh; y++)
    for (let x = 0; x < bw2; x++) {
      const i = y * bw2 + x;
      if (!dist[i]) continue;
      let d = dist[i];
      if (x > 0) d = Math.min(d, dist[i - 1] + 3);
      if (y > 0) {
        d = Math.min(d, dist[i - bw2] + 3);
        if (x > 0) d = Math.min(d, dist[i - bw2 - 1] + 4);
        if (x < bw2 - 1) d = Math.min(d, dist[i - bw2 + 1] + 4);
      } else d = Math.min(d, 3);
      if (x === 0) d = Math.min(d, 3);
      dist[i] = d;
    }
  for (let y = bh - 1; y >= 0; y--)
    for (let x = bw2 - 1; x >= 0; x--) {
      const i = y * bw2 + x;
      if (!dist[i]) continue;
      let d = dist[i];
      if (x < bw2 - 1) d = Math.min(d, dist[i + 1] + 3);
      else d = Math.min(d, 3);
      if (y < bh - 1) {
        d = Math.min(d, dist[i + bw2] + 3);
        if (x < bw2 - 1) d = Math.min(d, dist[i + bw2 + 1] + 4);
        if (x > 0) d = Math.min(d, dist[i + bw2 - 1] + 4);
      } else d = Math.min(d, 3);
      dist[i] = d;
    }

  // Cores: deeper than ~0.27 spaces (a notehead's half-height is ~0.5).
  const core = Math.round(s * 0.27 * 3);
  const seen = new Uint8Array(bw2 * bh);
  const heads: Notehead[] = [];
  const stack: number[] = [];
  for (let i = 0; i < dist.length; i++) {
    if (seen[i] || dist[i] < core) continue;
    let minX = bw2, maxX = 0, minY = bh, maxY = 0, n = 0, sx = 0, sy = 0, peak = 0;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop()!;
      const x = j % bw2;
      const y = (j / bw2) | 0;
      n++;
      sx += x;
      sy += y;
      peak = Math.max(peak, dist[j]);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (const k of [j - 1, j + 1, j - bw2, j + bw2]) {
        if (k < 0 || k >= dist.length || seen[k] || dist[k] < core) continue;
        if (Math.abs((k % bw2) - x) > 1) continue;
        seen[k] = 1;
        stack.push(k);
      }
    }
    const cw = maxX - minX + 1;
    const ch = maxY - minY + 1;
    // A notehead's core is a small oval: not long (beams), not tiny (noise/rest tails), not too
    // deep (blobs/text), and not a rectangle (half/whole rests are solid blocks on a line).
    if (cw > s * 1.3 || n < s * s * 0.1 || peak > s * 0.75 * 3) continue;
    const fill = n / (cw * ch);
    if (fill > 0.84 && cw > ch * 1.5) continue;
    // The clef (and its curl) lives at the very start of the staff.
    if (sx / n + x0 < staff.left + s * 3.2) continue;
    // Tall cores are stacked chord notes: split them every step.
    const count = Math.max(1, Math.round(ch / (s * 0.95)));
    for (let c = 0; c < count; c++) {
      const cy = (minY + (ch * (c + 0.5)) / count) + y0;
      const cx = sx / n + x0;
      heads.push({
        x: cx,
        y: count > 1 ? cy : sy / n + y0,
        step: Math.round(((staff.bottom - (count > 1 ? cy : sy / n + y0)) / s) * 2),
        staff: staffIndex,
        filled: true,
        rx: s * 0.62,
        ry: s * 0.48,
      });
    }
  }
  // Only heads plausibly on this staff (within 4 ledger lines).
  return heads.filter((hd) => hd.step >= -8 && hd.step <= 16).sort((a, b) => a.x - b.x);
}

/** Noteheads for every staff on the page. */
export function findAllNoteheads(geom: PageGeometry): Notehead[] {
  const staves = geom.systems.flatMap((s) => s.staves);
  return staves.flatMap((st, i) => {
    // Don't reach into the neighbouring staves' territory.
    const prev = staves[i - 1];
    const next = staves[i + 1];
    const yMin = prev ? (prev.bottom + st.top) / 2 : 0;
    const yMax = next ? (st.bottom + next.top) / 2 : geom.height;
    return findNoteheads(geom.pixels, geom.width, geom.height, st, i, yMin, yMax);
  });
}
