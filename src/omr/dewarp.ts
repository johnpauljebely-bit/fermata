// Straightens curved / tilted staff lines (browser + Node). Ported from server/dewarp.mjs.

const STRIP = 64; // px per vertical strip
const BAND = 160; // px per horizontal band (≈ one staff)
const MAX_STEP = 10; // max drift between neighbouring strips, px

/** Darkness profile (count of dark pixels per row) for one strip. */
function profile(gray: Uint8Array, width: number, height: number, x0: number, x1: number): Float32Array {
  const out = new Float32Array(height);
  for (let y = 0; y < height; y++) {
    let n = 0;
    const row = y * width;
    for (let x = x0; x < x1; x++) if (gray[row + x] < 128) n++;
    out[y] = n;
  }
  return out;
}

/** Best vertical offset of profile `b` against `a` within one band, and how sure we are. */
function bestShift(a: Float32Array, b: Float32Array, y0: number, y1: number): { shift: number; confident: boolean } {
  let best = 0;
  let bestScore = -Infinity;
  let zeroScore = 0;
  let energy = 0;
  for (let y = y0; y < y1; y++) energy += a[y] * a[y];
  for (let d = -MAX_STEP; d <= MAX_STEP; d++) {
    let score = 0;
    for (let y = Math.max(y0, -d); y < Math.min(y1, a.length - d); y++) score += a[y] * b[y + d];
    if (d === 0) zeroScore = score;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  // Blank bands (margins, gaps between staves) carry no information.
  const confident = energy > 0 && bestScore > zeroScore * 1.02 + 1 && bestScore > energy * 0.2;
  return { shift: best, confident: confident || best === 0 ? energy > 0 : false };
}

/**
 * @param {Uint8Array} gray  width*height grayscale pixels (0 = black)
 * @returns {{ pixels: Uint8Array, maxShift: number }}
 */
export function dewarp(gray: Uint8Array, width: number, height: number): { pixels: Uint8Array; maxShift: number } {
  const strips = Math.max(3, Math.floor(width / STRIP));
  const edges = Array.from({ length: strips + 1 }, (_, i) => Math.round((i * width) / strips));
  const profiles = Array.from({ length: strips }, (_, s) => profile(gray, width, height, edges[s], edges[s + 1]));
  const bands = Math.max(1, Math.ceil(height / BAND));
  const mid = Math.floor(strips / 2);

  // Cumulative vertical displacement of each strip, per band, relative to the middle strip.
  const disp: Float32Array[] = Array.from({ length: bands }, () => new Float32Array(strips));
  const known = Array.from({ length: bands }, () => new Uint8Array(strips));
  for (let b = 0; b < bands; b++) {
    const y0 = b * BAND;
    const y1 = Math.min(height, y0 + BAND);
    known[b][mid] = 1;
    for (const dir of [1, -1]) {
      let acc = 0;
      for (let s = mid + dir; s >= 0 && s < strips; s += dir) {
        const { shift, confident } = bestShift(profiles[s - dir], profiles[s], y0, y1);
        if (confident) {
          acc += shift;
          known[b][s] = 1;
        }
        disp[b][s] = acc;
      }
    }
  }

  // Bands without content (blank space) borrow from the nearest band that has some.
  const hasContent = disp.map((_, b) => known[b].reduce((a, k) => a + k, 0) > strips * 0.5);
  for (let b = 0; b < bands; b++) {
    if (hasContent[b]) continue;
    let near = -1;
    for (let r = 1; r < bands && near < 0; r++) {
      if (b - r >= 0 && hasContent[b - r]) near = b - r;
      else if (b + r < bands && hasContent[b + r]) near = b + r;
    }
    if (near >= 0) disp[b].set(disp[near]);
  }

  // Smooth across strips (kills single-strip jitter) and across bands.
  const smooth = disp.map((row) => row.map((_, s) => (row[Math.max(0, s - 1)] + row[s] * 2 + row[Math.min(strips - 1, s + 1)]) / 4));
  const final = smooth.map((row, b) =>
    row.map((v, s) => (smooth[Math.max(0, b - 1)][s] + v * 2 + smooth[Math.min(bands - 1, b + 1)][s]) / 4),
  );

  // Remap: each output pixel samples the source shifted by the interpolated displacement.
  const out = new Uint8Array(width * height).fill(255);
  const stripCenter = (s: number) => (edges[s] + edges[s + 1]) / 2;
  let maxShift = 0;
  const colStrip = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    let s = 0;
    while (s < strips - 1 && stripCenter(s + 1) < x) s++;
    const c0 = stripCenter(s);
    const c1 = stripCenter(Math.min(strips - 1, s + 1));
    colStrip[x] = s + (c1 > c0 ? Math.max(0, Math.min(1, (x - c0) / (c1 - c0))) : 0);
  }
  for (let y = 0; y < height; y++) {
    const bf = Math.max(0, Math.min(bands - 1, (y - BAND / 2) / BAND));
    const b0 = Math.floor(bf);
    const b1 = Math.min(bands - 1, b0 + 1);
    const tb = bf - b0;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const sf = colStrip[x];
      const s0 = Math.floor(sf);
      const s1 = Math.min(strips - 1, s0 + 1);
      const ts = sf - s0;
      const d =
        (final[b0][s0] * (1 - ts) + final[b0][s1] * ts) * (1 - tb) + (final[b1][s0] * (1 - ts) + final[b1][s1] * ts) * tb;
      const sy = Math.round(y + d);
      if (Math.abs(d) > maxShift) maxShift = Math.abs(d);
      if (sy >= 0 && sy < height) out[row + x] = gray[sy * width + x];
    }
  }
  return { pixels: out, maxShift: Math.round(maxShift) };
}
