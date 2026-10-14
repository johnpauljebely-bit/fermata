// The last few readings, kept on this device (IndexedDB) so they reopen without re-uploading.
import type { ScoreInfo } from "./ScoreScreen";

const KEEP = 3;
const DB = "fermata";
const STORE = "recent";

export interface Recent {
  id: string;
  title: string;
  savedAt: number;
  xml: string;
  /** ScoreInfo without the page images (those are stored as blobs). */
  info: Omit<ScoreInfo, "pages"> & { pages?: { layout: NonNullable<ScoreInfo["pages"]>["layout"] } };
  images: Blob[];
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    t.oncomplete = () => {
      db.close();
      resolve(req ? req.result : undefined);
    };
    t.onerror = () => reject(t.error);
  });
}

/** Newest first. */
export async function listRecent(): Promise<Recent[]> {
  try {
    const all = ((await tx("readonly", (s) => s.getAll())) ?? []) as Recent[];
    return all.sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}

/** Saves a finished reading (page images fetched into blobs: hosted data URLs, the Mac's page URLs). */
export async function saveRecent(xml: string, info: ScoreInfo, pageUrl: (id: string, n: number) => string): Promise<void> {
  try {
    const pages = info.pages;
    const urls = pages ? (pages.images ?? (pages.jobId ? pages.layout.pages.map((_, n) => pageUrl(pages.jobId!, n + 1)) : [])) : [];
    const images = await Promise.all(urls.map((u) => fetch(u).then((r) => (r.ok ? r.blob() : Promise.reject())))).catch(() => [] as Blob[]);
    const { pages: _drop, ...rest } = info;
    const entry: Recent = {
      id: `r${Date.now()}`,
      title: info.title || "Untitled",
      savedAt: Date.now(),
      xml,
      info: { ...rest, ...(pages && images.length ? { pages: { layout: pages.layout } } : {}) },
      images,
    };
    const old = await listRecent();
    await tx("readwrite", (s) => {
      s.put(entry);
      for (const r of old.slice(KEEP - 1)) s.delete(r.id);
    });
  } catch {
    // Remembering is a convenience; never block the reading on it.
  }
}

export async function removeRecent(id: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(id)).catch(() => undefined);
}

/** Turns a saved reading back into what the score screen takes. */
export function openRecent(r: Recent): { xml: string; info: ScoreInfo } {
  const images = r.images.map((b) => URL.createObjectURL(b));
  const info: ScoreInfo = { ...r.info, pages: r.info.pages && images.length ? { images, layout: r.info.pages.layout } : undefined };
  return { xml: r.xml, info };
}
