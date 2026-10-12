// Talks to the little server running on the Mac (server/plugin.mjs).

export interface Status {
  reader: boolean;
  straighten: boolean;
  ai: { gemini: boolean; groq: boolean };
  /** Running on Vercel: no music reader, the AI reads pages in one request. */
  hosted?: boolean;
}

export interface Expression {
  type: "dynamic" | "crescendo" | "diminuendo" | "articulation" | "tempo" | "ritardando" | "accelerando";
  value?: string;
  measure: number;
  beat?: number;
  endMeasure?: number;
  endBeat?: number;
  part?: number;
  bpm?: number;
  text?: string;
}

export interface AIResult {
  title?: string | null;
  composer?: string | null;
  tempo?: { bpm: number | null; text: string | null } | null;
  key?: { fifths: number; mode?: string } | null;
  time?: { beats: number; beatType: number } | null;
  expressions?: Expression[];
  noteFixes?: { measure: number; part?: number; beat?: number; from: string; to: string; reason?: string }[];
  skippedMeasures?: { afterMeasure: number; count: number; where?: string }[];
  parts?: {
    name: string;
    clef: string;
    measures: { events: { pitches: string[]; duration: string; dots?: number; tieToNext?: boolean }[] }[];
  }[];
  confidence?: "high" | "medium" | "low";
  notes?: string;
}

export interface AIAnswer {
  mode: "check" | "transcribe";
  provider: string;
  model: string;
  result: AIResult;
}

export interface PageLayout {
  pages: {
    page: number;
    width: number;
    height: number;
    systems: { top: number; bottom: number; measures: { id: number; left: number; right: number; slots: { x: number; beat: number }[] }[] }[];
  }[];
}

export interface ReadProgress {
  state: "queued" | "running" | "done" | "error" | "cancelled";
  phase: "queued" | "prepare" | "straighten" | "recognize" | "ai";
  progress: number;
  pages: number;
  seconds: number;
  queuePosition: number;
  error: string | null;
  pieces?: string[];
  pageCount?: number;
  layout?: PageLayout | null;
  ai?: AIAnswer | null;
  aiError?: string | null;
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `Something went wrong (${res.status}).`);
  return body as T;
}

export const getStatus = () => fetch("/api/status").then((r) => json<Status>(r));

/**
 * Sends a page. On your Mac the answer is a job id to poll; on Vercel (no jobs) the request
 * waits and answers with the finished reading.
 */
export async function startReading(file: Blob): Promise<{ id: string } | ReadProgress> {
  const res = await fetch("/api/read", { method: "POST", body: file, headers: { "Content-Type": "application/octet-stream" } });
  return json<{ id: string } | ReadProgress>(res);
}

/** Shrinks a photo for upload (long side ≤ 2200 px, JPEG): phone photos are 3–12 MB. */
export async function shrinkPhoto(file: File): Promise<Blob> {
  if (!file.type.startsWith("image/") || file.size < 1.5 * 1024 * 1024) return file;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, 2200 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    return blob ?? file;
  } catch {
    return file;
  }
}

export const readProgress = (id: string) => fetch(`/api/read/${id}`, { cache: "no-store" }).then((r) => json<ReadProgress>(r));
export const cancelReading = (id: string) => fetch(`/api/read/${id}/cancel`, { method: "POST" }).catch(() => undefined);
export const pageUrl = (id: string, n: number) => `/api/read/${id}/page/${n}`;
