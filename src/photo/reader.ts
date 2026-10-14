// The new reader: your own photo is the score.
//   1. Fermata's page reader (in the browser) straightens each page and finds staves, bars
//      and filled noteheads (exact positions → exact staff steps).
//   2. Each line of music is cropped at full resolution and sent to the AI with what we
//      measured ("2 staves, 3 bars here, 4 noteheads in bar 1 …"), so it can't skip lines.
//   3. score.ts matches the AI's notes to our noteheads.

import { analyzePage, findAllNoteheads, WORK_SIZE, type Notehead, type PageGeometry, type SystemGeom } from "../omr/geometry.ts";

export interface LineAI {
  staves: { clef?: string; key?: number; name?: string | null }[];
  time?: { beats: number; beatType: number } | null;
  tempo?: { bpm: number | null; text: string | null } | null;
  bars: { multiRest?: number; staves: { voices: { pitches: string[]; duration: string; dots?: number; tie?: boolean }[][] }[] }[];
  expressions?: { type: string; value?: string; bar: number; beat?: number; staff?: number; endBar?: number; endBeat?: number }[];
}

export interface ReadPage {
  geometry: PageGeometry;
  heads: Notehead[];
  /** Straightened page (black & white) to display. */
  imageUrl: string;
}

export interface ReadLine {
  page: number;
  system: number;
  ai: LineAI | null;
  error?: string;
}

export interface PhotoReading {
  pages: ReadPage[];
  lines: ReadLine[];
  provider?: string;
}

export type Progress = (phase: "pages" | "lines", done: number, total: number) => void;

/** Long images: a photo, an image file, or a rendered PDF page. */
export async function readPages(sources: (Blob | HTMLCanvasElement)[], onProgress: Progress): Promise<PhotoReading> {
  const pages: ReadPage[] = [];
  for (let i = 0; i < sources.length; i++) {
    onProgress("pages", i, sources.length);
    const page = await readOnePage(sources[i]);
    if (page) pages.push(page);
    await new Promise((r) => setTimeout(r, 16));
  }
  onProgress("pages", sources.length, sources.length);

  // Every line of every page, in reading order.
  const jobs = pages.flatMap((p, pi) => p.geometry.systems.map((_, si) => ({ page: pi, system: si })));
  const lines: ReadLine[] = jobs.map((j) => ({ ...j, ai: null }));
  let provider: string | undefined;
  let done = 0;
  onProgress("lines", 0, jobs.length);

  // Clef/key/time carry over from line to line; the first line sets them.
  let carry = "";
  const run = async (k: number) => {
    const { page, system } = jobs[k];
    const p = pages[page];
    try {
      const crop = await cropLine(p.geometry, p.geometry.systems[system]);
      const hint = describeLine(p.geometry, p.geometry.systems[system], p.heads, carry);
      const res = await fetch(`/api/read-line?hint=${encodeURIComponent(hint)}`, { method: "POST", body: crop, headers: { "Content-Type": "application/octet-stream" } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      lines[k].ai = body.result as LineAI;
      provider ??= body.provider ? `${body.provider}` : undefined;
    } catch (e) {
      lines[k].error = (e as Error).message;
    }
    onProgress("lines", ++done, jobs.length);
  };
  if (jobs.length) {
    await run(0);
    const first = lines[0].ai;
    if (first) {
      const clefs = first.staves.map((s) => s.clef ?? "treble").join(", ");
      carry = `Earlier in the piece: staves use ${clefs}; key ${first.staves[0]?.key ?? 0} fifths${first.time ? `; time ${first.time.beats}/${first.time.beatType}` : ""}.`;
    }
    // The rest, three at a time (keeps within free-tier rate limits).
    let next = 1;
    const worker = async () => {
      while (next < jobs.length) await run(next++);
    };
    await Promise.all([worker(), worker(), worker()]);
  }
  return { pages, lines, provider };
}

async function readOnePage(source: Blob | HTMLCanvasElement): Promise<ReadPage | null> {
  let draw: CanvasImageSource;
  let sw: number;
  let sh: number;
  if (source instanceof Blob) {
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(source, { imageOrientation: "from-image" });
    } catch {
      return null;
    }
    draw = bitmap;
    sw = bitmap.width;
    sh = bitmap.height;
  } else {
    draw = source;
    sw = source.width;
    sh = source.height;
  }
  const scale = Math.min(1, WORK_SIZE / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(draw, 0, 0, w, h);
  if ("close" in draw) (draw as ImageBitmap).close();
  const rgba = ctx.getImageData(0, 0, w, h);
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < gray.length; i++) gray[i] = (rgba.data[i * 4] * 0.299 + rgba.data[i * 4 + 1] * 0.587 + rgba.data[i * 4 + 2] * 0.114) | 0;

  const geometry = analyzePage(gray, w, h);
  if (!geometry.systems.length) return null;
  const heads = findAllNoteheads(geometry);

  const out = ctx.createImageData(w, h);
  for (let i = 0; i < geometry.pixels.length; i++) {
    const v = geometry.pixels[i];
    out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = v;
    out.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
  return { geometry, heads, imageUrl: blob ? URL.createObjectURL(blob) : canvas.toDataURL("image/png") };
}

/** The line, with room above (chord symbols, dynamics) and below (lyrics), as a JPEG. */
async function cropLine(g: PageGeometry, sys: SystemGeom): Promise<Blob> {
  const s = g.space;
  const top = Math.max(0, Math.round(sys.top - s * 4.5));
  const bottom = Math.min(g.height, Math.round(sys.bottom + s * 5));
  const left = Math.max(0, Math.round(Math.min(...sys.staves.map((st) => st.left)) - s * 2));
  const right = Math.min(g.width, Math.round(Math.max(...sys.staves.map((st) => st.right)) + s * 2));
  const w = right - left;
  const h = bottom - top;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = g.pixels[(y + top) * g.width + x + left];
      const i = (y * w + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  return new Promise((r) => canvas.toBlob((b) => r(b!), "image/jpeg", 0.9));
}

/** What we measured on this line, in words for the AI. */
export function describeLine(g: PageGeometry, sys: SystemGeom, heads: Notehead[], carry: string): string {
  const allStaves = g.systems.flatMap((s) => s.staves);
  const lineLeft = Math.min(...sys.staves.map((st) => st.left));
  const lineRight = Math.max(...sys.staves.map((st) => st.right));
  const pct = (x: number) => Math.round(((x - lineLeft) / Math.max(1, lineRight - lineLeft)) * 100);
  const lines = sys.bars.map(([l, r], i) => {
    const perStaff = sys.staves.map((st) => {
      const idx = allStaves.indexOf(st);
      return heads.filter((h) => h.staff === idx && h.x >= l && h.x < r).length;
    });
    return `bar ${i + 1}: ${pct(l)}%–${pct(r)}% of the width; filled noteheads seen per staff: ${perStaff.join(", ")}`;
  });
  return [
    `This line has ${sys.staves.length} staff${sys.staves.length > 1 ? "s" : ""} and ${sys.bars.length} bar box${sys.bars.length > 1 ? "es" : ""} (a multi-bar rest is one box).`,
    ...lines,
    "(Hollow notes — half and whole notes — are not counted above.)",
    carry,
  ]
    .filter(Boolean)
    .join("\n");
}
