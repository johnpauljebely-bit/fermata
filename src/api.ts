// Talks to the little server running on the Mac (server/plugin.mjs).

export interface Status {
  reader: boolean;
  straighten: boolean;
  ai: { gemini: boolean; groq: boolean };
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

export async function startReading(file: Blob): Promise<string> {
  const res = await fetch("/api/read", { method: "POST", body: file, headers: { "Content-Type": "application/octet-stream" } });
  return (await json<{ id: string }>(res)).id;
}

export const readProgress = (id: string) => fetch(`/api/read/${id}`, { cache: "no-store" }).then((r) => json<ReadProgress>(r));
export const cancelReading = (id: string) => fetch(`/api/read/${id}/cancel`, { method: "POST" }).catch(() => undefined);
export const pageUrl = (id: string, n: number) => `/api/read/${id}/page/${n}`;
