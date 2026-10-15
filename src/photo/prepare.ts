// Gets a phone photo ready for the music reader (Audiveris). The reader needs staff lines
// about 20 px apart; in a phone photo the page fills only part of the frame and the lines
// end up 6–9 px apart, so it gives up. We find the music with Fermata's page reader, crop
// to it, and scale it so the lines are ~20 px apart.

import { analyzePage } from "../omr/geometry.ts";

/** Staff-line spacing the reader likes best. */
const TARGET_SPACE = 20;
/** Long sides we look at to find the music (thin photo lines need room; bigger only if needed). */
const LOOK_SIZES = [2600, 3400];
/** Stay well inside phone canvas limits (iOS: ~16.7 M pixels). */
const MAX_PIXELS = 14_000_000;
const MAX_SIDE = 4600;
/** Vercel accepts 4.5 MB per request. */
const MAX_BYTES = 4_000_000;

function grayOf(ctx: CanvasRenderingContext2D, w: number, h: number): Uint8Array {
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < gray.length; i++) gray[i] = (rgba[i * 4] * 0.299 + rgba[i * 4 + 1] * 0.587 + rgba[i * 4 + 2] * 0.114) | 0;
  return gray;
}

async function encode(canvas: HTMLCanvasElement): Promise<Blob | null> {
  for (const q of [0.9, 0.82, 0.72, 0.6]) {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", q));
    if (!blob || blob.size <= MAX_BYTES) return blob;
  }
  return null;
}

/** Returns the prepared photo, or null if the browser can't open it (e.g. a PDF). */
export async function preparePhoto(file: Blob): Promise<Blob | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return null;
  }
  const W = bitmap.width;
  const H = bitmap.height;

  // 1. Find the staves (the page reader wants lines ~9+ px apart; enlarge if the page is small).
  await new Promise((r) => setTimeout(r, 20)); // let the reading screen paint first
  let look = 1;
  let lw = W;
  let lh = H;
  let geom: ReturnType<typeof analyzePage> | null = null;
  for (const size of LOOK_SIZES) {
    look = size / Math.max(W, H);
    lw = Math.round(W * look);
    lh = Math.round(H * look);
    const small = document.createElement("canvas");
    small.width = lw;
    small.height = lh;
    const sctx = small.getContext("2d", { willReadFrequently: true })!;
    sctx.imageSmoothingQuality = "high";
    sctx.drawImage(bitmap, 0, 0, lw, lh);
    geom = analyzePage(grayOf(sctx, lw, lh), lw, lh);
    if (geom.systems.flatMap((sy) => sy.staves).length >= 2 && geom.space >= 8) break;
  }
  const staves = geom!.systems.flatMap((sy) => sy.staves);

  // 2. Crop to the music (with room for lyrics, ledger lines and the title), in full-size pixels.
  let crop = { x: 0, y: 0, w: W, h: H };
  let space = 0;
  if (staves.length && geom!.space > 0) {
    space = geom!.space / look;
    // Generous: a faint staff at the top or bottom may have been missed (a staff plus its gap
    // is ~12 spaces), and a little background never hurts the reader.
    const padX = geom!.space * 8;
    const padY = geom!.space * 20;
    const x0 = Math.max(0, Math.min(...staves.map((s) => s.left)) - padX);
    const x1 = Math.min(lw, Math.max(...staves.map((s) => s.right)) + padX);
    const y0 = Math.max(0, staves[0].top - padY);
    const y1 = Math.min(lh, staves[staves.length - 1].bottom + padY);
    // Only crop when we clearly see the music (a stray staff or two could cut the rest off).
    if (staves.length >= 3 && x1 - x0 > lw * 0.25 && y1 - y0 > lh * 0.1) crop = { x: x0 / look, y: y0 / look, w: (x1 - x0) / look, h: (y1 - y0) / look };
  }

  // 3. Scale so the staff lines are ~TARGET_SPACE apart (or, if we found none, as big as we can).
  let k = space ? TARGET_SPACE / space : Infinity;
  k = Math.min(k, MAX_SIDE / Math.max(crop.w, crop.h), Math.sqrt(MAX_PIXELS / (crop.w * crop.h)));
  if (!space) k = Math.min(k, 1); // nothing to aim for: keep the photo's own resolution
  const ow = Math.max(1, Math.round(crop.w * k));
  const oh = Math.max(1, Math.round(crop.h * k));

  const out = document.createElement("canvas");
  out.width = ow;
  out.height = oh;
  const ctx = out.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.filter = "grayscale(1) contrast(1.15)";
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, ow, oh);
  ctx.drawImage(bitmap, crop.x, crop.y, crop.w, crop.h, 0, 0, ow, oh);
  bitmap.close();
  return encode(out);
}
