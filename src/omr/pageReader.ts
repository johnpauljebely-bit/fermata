// Runs Fermata's page reader in the browser on a photo: straightens it, finds the lines of
// music and bars, and gives back (a) the straightened page to show and send to the AI,
// (b) bar positions for the "Your pages" view, and (c) a hint telling the AI how many lines
// and bars to read.

import type { PageLayout } from "../api";
import { analyzePage, describeForAI, WORK_SIZE, type PageGeometry } from "./geometry.ts";

export interface PageReading {
  geometry: PageGeometry;
  /** The straightened page (JPEG). */
  image: Blob;
  imageUrl: string;
  layout: PageLayout;
  hint: string;
}

export async function readPagePhoto(file: Blob): Promise<PageReading | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return null; // not an image the browser can open (e.g. a PDF)
  }
  const scale = Math.min(1, WORK_SIZE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  const rgba = ctx.getImageData(0, 0, w, h);
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < gray.length; i++) gray[i] = (rgba.data[i * 4] * 0.299 + rgba.data[i * 4 + 1] * 0.587 + rgba.data[i * 4 + 2] * 0.114) | 0;

  // Let the "reading" screen paint before the number-crunching.
  await new Promise((r) => setTimeout(r, 30));
  const geometry = analyzePage(gray, w, h);
  if (!geometry.systems.length) return null;

  // The straightened page, as clean black & white.
  const out = ctx.createImageData(w, h);
  for (let i = 0; i < geometry.pixels.length; i++) {
    const v = geometry.pixels[i];
    out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = v;
    out.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  const image = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
  if (!image) return null;

  const layout: PageLayout = {
    pages: [
      {
        page: 1,
        width: w,
        height: h,
        systems: (() => {
          let id = 0;
          return geometry.systems.map((s) => ({
            top: s.top,
            bottom: s.bottom,
            measures: s.bars.map(([left, right]) => ({ id: ++id, left, right, slots: [] })),
          }));
        })(),
      },
    ],
  };
  return { geometry, image, imageUrl: URL.createObjectURL(image), layout, hint: describeForAI(geometry) };
}
