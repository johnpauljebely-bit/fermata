// Snap & Play's local server (runs inside Vite on your Mac; your phone talks to it over Wi-Fi).
//
//   GET  /api/status            → { reader, straighten, ai: { gemini, groq } }
//   POST /api/read              → body = photo/PDF bytes → { id }
//   GET  /api/read/:id          → progress, then { pieces: [MusicXML…], ai, aiError }
//   GET  /api/read/:id/page/:n  → page n as the reader saw it (PNG)
//   POST /api/read/:id/cancel

import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { aiProviders, askAI } from "./ai.mjs";
import { dewarp } from "./dewarp.mjs";
import { summarizeScore } from "./summary.mjs";

const AUDIVERIS = [
  process.env.AUDIVERIS_PATH,
  "/Applications/Audiveris.app/Contents/MacOS/Audiveris",
  path.join(os.homedir(), "Applications/Audiveris.app/Contents/MacOS/Audiveris"),
  "/opt/audiveris/bin/Audiveris",
].filter(Boolean);
const STEPS = ["LOAD", "BINARY", "SCALE", "GRID", "HEADERS", "STEM_SEEDS", "BEAMS", "LEDGERS", "HEADS", "STEMS", "REDUCTION", "CUE_BEAMS", "TEXTS", "MEASURES", "CHORDS", "CURVES", "SYMBOLS", "LINKS", "RHYTHMS", "PAGE"];
const MAX_BYTES = 40 * 1024 * 1024;
const TIMEOUT_MS = 20 * 60 * 1000;
const WORK_DIR = path.join(os.tmpdir(), "snap-play");
const TARGET_PIXELS = 9_000_000;
// Curved/tilted scans and photos: accept steeper staff lines (otherwise whole lines vanish).
const TILT = ["-constant", "org.audiveris.omr.sheet.grid.LinesRetriever.maxSlopeDiff=0.1"];

const shared = (globalThis.__snapPlay ??= { jobs: new Map(), queue: [] });
const { jobs, queue } = shared;

const findAudiveris = () => AUDIVERIS.find((p) => existsSync(p)) ?? null;
let magickBin;
function findMagick() {
  if (magickBin !== undefined) return magickBin;
  for (const c of ["magick", "/opt/homebrew/bin/magick", "/usr/local/bin/magick"]) {
    try {
      execFileSync(c, ["-version"], { stdio: "ignore" });
      return (magickBin = c);
    } catch {
      // next
    }
  }
  return (magickBin = null);
}

function sniff(b) {
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "pdf";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return "heic"; // iPhone photos
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 0x2a)) return "tif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return "webp";
  return null;
}

function pdfResolution(bytes) {
  const text = bytes.toString("latin1");
  let largest = 0;
  for (const m of text.matchAll(/\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/g)) {
    const area = (Math.abs(m[3] - m[1]) / 72) * (Math.abs(m[4] - m[2]) / 72);
    if (area > 0) largest = Math.max(largest, area);
  }
  return largest ? Math.max(72, Math.min(300, Math.floor(Math.sqrt(TARGET_PIXELS / largest)))) : 300;
}

async function findFiles(dir, ext) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await findFiles(full, ext)));
    else if (entry.name.toLowerCase().endsWith(ext)) out.push(full);
  }
  return out.sort();
}

function runAudiveris(job, args) {
  return new Promise((resolve) => {
    const child = spawn(job.reader, args, { env: { ...process.env, JAVA_TOOL_OPTIONS: "-Djava.awt.headless=true" } });
    job.child = child;
    let buffer = "";
    job.log = [];
    const feed = (data) => {
      buffer += data.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        job.log.push(line.slice(0, 300));
        if (job.log.length > 40) job.log.shift();
        const sheets = /\|\s+(\d+)\s+sheets?\s+in\s/.exec(line);
        if (sheets) job.pages = Number(sheets[1]);
        const step = /StepMonitoring\s+\d+\s+\|\s+([A-Z_]+)\s*$/.exec(line);
        if (step && job.phase === "recognize") {
          const i = STEPS.indexOf(step[1]);
          if (i >= 0) {
            if (i < job.stepIndex) job.pageDone = Math.min(job.pages - 1, job.pageDone + 1);
            job.stepIndex = i;
          }
        }
      }
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("error", () => resolve(-1));
    child.on("close", (code) => {
      job.child = undefined;
      if (code !== 0) console.error(`Audiveris exited ${code}:\n${job.log.join("\n")}`);
      resolve(code ?? -1);
    });
  });
}

/** Phone photos: turn upright (EXIF), convert HEIC/WebP, cap the size. */
function normalizePhoto(job) {
  const magick = findMagick();
  if (!magick) return job.input;
  const out = path.join(job.dir, "photo.png");
  execFileSync(magick, [job.input, "-auto-orient", "-resize", "3200x3200>", "-colorspace", "Gray", out]);
  return out;
}

async function straighten(job, prepDir) {
  const magick = findMagick();
  const [omr] = await findFiles(prepDir, ".omr");
  if (!magick || !omr) return null;
  const files = unzipSync(new Uint8Array(await fs.readFile(omr)), { filter: (f) => /^sheet#\d+\/BINARY\.png$/.test(f.name) });
  const sheets = Object.keys(files).sort((a, b) => Number(/#(\d+)/.exec(a)[1]) - Number(/#(\d+)/.exec(b)[1]));
  if (!sheets.length) return null;
  const flat = [];
  for (const [i, name] of sheets.entries()) {
    const src = path.join(prepDir, `page-${i + 1}.png`);
    await fs.writeFile(src, files[name]);
    const [w, h] = execFileSync(magick, ["identify", "-format", "%w %h", src]).toString().split(" ").map(Number);
    const gray = new Uint8Array(execFileSync(magick, [src, "-colorspace", "Gray", "-depth", "8", "gray:-"], { maxBuffer: 1 << 28 }));
    const { pixels } = dewarp(gray, w, h);
    const out = path.join(prepDir, `flat-${i + 1}.png`);
    execFileSync(magick, ["-size", `${w}x${h}`, "-depth", "8", "gray:-", out], { input: Buffer.from(pixels) });
    flat.push(out);
  }
  const tif = path.join(prepDir, "pages.tif");
  execFileSync(magick, [...flat, "-compress", "Group4", tif]);
  return tif;
}

async function pageImages(job) {
  const [omr] = await findFiles(path.join(job.dir, "out"), ".omr");
  if (!omr) return [];
  const files = unzipSync(new Uint8Array(await fs.readFile(omr)), { filter: (f) => /^sheet#\d+\/BINARY\.png$/.test(f.name) });
  return Object.keys(files)
    .sort((a, b) => Number(/#(\d+)/.exec(a)[1]) - Number(/#(\d+)/.exec(b)[1]))
    .map((name) => files[name]);
}

async function runJob(job, keys) {
  job.state = "running";
  job.started = Date.now();
  const timer = setTimeout(() => {
    job.timedOut = true;
    job.child?.kill("SIGKILL");
  }, TIMEOUT_MS);
  const stopped = () => job.state === "cancelled" || job.timedOut;

  try {
    let source = job.input;
    if (["jpg", "png", "heic", "webp", "tif"].includes(job.kind)) {
      job.phase = "prepare";
      source = normalizePhoto(job);
    }

    // 1. The music reader (Audiveris), on straightened pages.
    if (job.reader) {
      const base = ["-batch", ...TILT];
      if (job.kind === "pdf") base.push("-constant", `org.audiveris.omr.image.ImageLoading.pdfResolution=${pdfResolution(job.bytes)}`);
      if (findMagick()) {
        job.phase = "prepare";
        const prepDir = path.join(job.dir, "prep");
        await fs.mkdir(prepDir, { recursive: true });
        await runAudiveris(job, [...base, "-step", "BINARY", "-save", "-output", prepDir, "--", source]);
        if (stopped()) throw new Error("stopped");
        job.phase = "straighten";
        try {
          source = (await straighten(job, prepDir)) ?? source;
        } catch {
          // straightening is a bonus; carry on with the original
        }
      }
      if (stopped()) throw new Error("stopped");
      job.phase = "recognize";
      job.stepIndex = -1;
      job.pageDone = 0;
      await runAudiveris(job, [...base, "-export", "-output", path.join(job.dir, "out"), "--", source]);
      for (const mxl of await findFiles(path.join(job.dir, "out"), ".mxl")) {
        const files = unzipSync(new Uint8Array(await fs.readFile(mxl)));
        const root = /full-path="([^"]+)"/.exec(strFromU8(files["META-INF/container.xml"] ?? new Uint8Array()))?.[1];
        const xml = root && files[root] ? strFromU8(files[root]) : null;
        if (xml) job.pieces.push(xml);
      }
      job.pageCount = (await pageImages(job)).length;
      job.layout = await readLayout(job).catch(() => null);
    }
    if (stopped()) throw new Error("stopped");

    // 2. The AI: check the reader's work (or transcribe the page itself).
    const providers = aiProviders(keys);
    if (providers.gemini || providers.groq) {
      job.phase = "ai";
      const images = [];
      if (job.pieces.length) {
        for (const png of await pageImages(job)) images.push({ mime: "image/png", base64: Buffer.from(png).toString("base64") });
      }
      if (!images.length) {
        if (job.kind === "pdf") images.push({ mime: "application/pdf", base64: job.bytes.toString("base64") });
        else images.push({ mime: "image/png", base64: (await fs.readFile(source)).toString("base64") });
      }
      const mode = job.pieces.length ? "check" : "transcribe";
      const context = job.pieces.length
        ? `THE MUSIC READER'S TRANSCRIPTION (bar by bar; q=quarter h=half w=whole 8=eighth 16=16th; "." = dotted; "~" = tied to next; "+" = chord):\n${summarizeScore(job.pieces).text}`
        : job.hint || "(no reader result)";
      try {
        job.ai = { mode, ...(await askAI(keys, mode, context, images)) };
      } catch (error) {
        job.aiError = error.message;
      }
    }

    if (job.pieces.length || job.ai?.mode === "transcribe") job.state = "done";
    else {
      job.state = "error";
      job.error = job.reader
        ? job.aiError
          ? `Couldn't read any music. (AI: ${job.aiError})`
          : "Couldn't read any music on that page. Try a sharper, straighter, well-lit photo."
        : "Install Audiveris or add an AI key in .env.local to read music.";
    }
  } catch {
    if (job.state !== "cancelled") {
      job.state = "error";
      job.error = job.timedOut ? "Reading took too long and was stopped." : "Reading stopped.";
    }
  }
  clearTimeout(timer);
  job.finished = Date.now();
  job.bytes = undefined;
  pump(keys);
}

/** Where each bar sits on each page (same pixels as the page images), from Audiveris' .omr. */
async function readLayout(job) {
  const [omr] = await findFiles(path.join(job.dir, "out"), ".omr");
  if (!omr) return null;
  const files = unzipSync(new Uint8Array(await fs.readFile(omr)), { filter: (f) => /^sheet#\d+\/sheet#\d+\.xml$/.test(f.name) });
  const sheets = Object.keys(files)
    .map((name) => [name, Number(/^sheet#(\d+)/.exec(name)[1])])
    .sort((a, b) => a[1] - b[1]);
  const pages = [];
  for (const [name, n] of sheets) {
    const xml = strFromU8(files[name]);
    const picture = /<picture width="(\d+)" height="(\d+)"/.exec(xml);
    if (!picture) continue;
    const systems = [];
    for (const sys of xml.matchAll(/<system id="\d+">([\s\S]*?)<\/system>/g)) {
      const body = sys[1];
      const ys = [...body.matchAll(/<line [^>]*>([\s\S]*?)<\/line>/g)].flatMap((l) => [...l[1].matchAll(/<point x="[\d.]+" y="([\d.]+)"/g)].map((p) => Number(p[1])));
      if (!ys.length) continue;
      // Stack ids are page-local bar numbers; a multi-bar rest is one stack whose id is the last bar it covers.
      const measures = [...body.matchAll(/<stack id="(\d+)" left="(\d+)" right="(\d+)"[^>]*?(?:\/>|>([\s\S]*?)<\/stack>)/g)].map((st) => ({
        id: Number(st[1]),
        left: Number(st[2]),
        right: Number(st[3]),
        slots: [...(st[4] ?? "").matchAll(/<slot id="\d+" x-offset="(-?[\d.]+)" time-offset="([\d/]+)"/g)].map((sl) => {
          const [a, b = "1"] = sl[2].split("/");
          return { x: Number(st[2]) + Number(sl[1]), beat: (Number(a) / Number(b)) * 4 };
        }),
      }));
      // Staves (which part each belongs to, top to bottom) and every notehead with its box.
      const staves = [];
      for (const pm of body.matchAll(/<part id="(\d+)"[^>]*>([\s\S]*?)(?=<part id=|$)/g)) {
        for (const st of pm[2].matchAll(/<staff id="(\d+)"[^>]*>([\s\S]*?)<\/staff>/g)) {
          const sy = [...st[2].matchAll(/<line [^>]*>([\s\S]*?)<\/line>/g)].flatMap((l) => [...l[1].matchAll(/<point x="[\d.]+" y="([\d.]+)"/g)].map((q) => Number(q[1])));
          if (sy.length) staves.push({ id: Number(st[1]), part: Number(pm[1]), top: Math.min(...sy), bottom: Math.max(...sy) });
        }
      }
      staves.sort((a, b) => a.top - b.top);
      const heads = [...body.matchAll(/<head pitch="(-?\d+)" shape="([A-Z_]+)"[^>]*staff="(\d+)"[^>]*>\s*<bounds x="(\d+)" y="(\d+)" w="(\d+)" h="(\d+)"/g)].map((hm) => ({
        pitch: Number(hm[1]),
        shape: hm[2],
        staff: Number(hm[3]),
        x: Number(hm[4]),
        y: Number(hm[5]),
        w: Number(hm[6]),
        h: Number(hm[7]),
      }));
      systems.push({ top: Math.min(...ys), bottom: Math.max(...ys), measures, staves, heads });
    }
    pages.push({ page: n, width: Number(picture[1]), height: Number(picture[2]), systems });
  }
  return { pages };
}

const KEEP_MS = 6 * 60 * 60 * 1000;

/** Forgets finished readings after a few hours and deletes their temporary files. */
function cleanup() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.state === "running" || job.state === "queued") continue;
    if (now - (job.finished ?? job.started) > KEEP_MS) {
      jobs.delete(id);
      fs.rm(job.dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function pump(keys) {
  if ([...jobs.values()].some((j) => j.state === "running")) return;
  const next = queue.shift();
  if (next) void runJob(next, keys);
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BYTES) {
        reject(new Error("too-large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function progressOf(job) {
  if (job.state === "done") return 1;
  if (job.state === "queued") return 0;
  const perPage = STEPS.length;
  const recog = job.phase === "recognize" ? Math.min(1, (job.pageDone * perPage + Math.max(0, job.stepIndex + 1)) / (Math.max(1, job.pages) * perPage)) : 0;
  const hasAI = job.hasAI;
  const recogShare = hasAI ? 0.7 : 0.85;
  return { prepare: 0.05, straighten: 0.12, recognize: 0.15 + recogShare * recog, ai: 0.15 + recogShare + 0.02 }[job.phase] ?? 0.02;
}

/** The API as a plain Node request handler (used by the Vite plugin and by reader/server.mjs). */
export function createHandler(keys) {
  return async (req, res, next) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (!url.pathname.startsWith("/api/")) return next();
    try {
      if (req.method === "GET" && url.pathname === "/api/status") {
        return json(res, 200, { reader: Boolean(findAudiveris()), straighten: Boolean(findMagick()), ai: aiProviders(keys) });
      }
      if (req.method === "POST" && (url.pathname === "/api/read-line" || url.pathname === "/api/read-page")) {
        const pageMode = url.pathname === "/api/read-page";
        if (!aiProviders(keys).gemini && !aiProviders(keys).groq) return json(res, 503, { error: "No AI key yet (add one to .env.local)." });
        const hint = (url.searchParams.get("hint") ?? "").slice(0, 6000);
        const bytes = await readBody(req);
        try {
          const ai = await askAI(keys, pageMode ? "page" : "line", `DETECTOR:\n${hint}`, [{ mime: "image/jpeg", base64: bytes.toString("base64") }]);
          return json(res, 200, { provider: ai.provider, model: ai.model, result: ai.result });
        } catch (error) {
          return json(res, 502, { error: error.message });
        }
      }
      // /api/read-sync: the same reading, but answered in one request when it's finished (with the
      // page images inline). For hosts that only give CPU during a request, like Google Cloud Run.
      const sync = url.pathname === "/api/read-sync";
      if (req.method === "POST" && (url.pathname === "/api/read" || sync)) {
        cleanup();
        const bytes = await readBody(req);
        const kind = sniff(bytes);
        if (!kind) return json(res, 415, { error: "That isn't a photo or a PDF." });
        const reader = findAudiveris();
        const providers = aiProviders(keys);
        if (!reader && !providers.gemini && !providers.groq) return json(res, 503, { error: "Nothing to read music with: install Audiveris or add an AI key in .env.local." });
        const id = randomUUID();
        const dir = path.join(WORK_DIR, id);
        await fs.mkdir(path.join(dir, "out"), { recursive: true });
        const input = path.join(dir, `upload.${kind}`);
        await fs.writeFile(input, bytes);
        const hint = (url.searchParams.get("hint") ?? "").slice(0, 2000);
        const job = { id, dir, input, kind, bytes, reader, hint, state: "queued", phase: "queued", pages: 1, pageDone: 0, stepIndex: -1, pieces: [], started: Date.now(), hasAI: providers.gemini || providers.groq };
        jobs.set(id, job);
        queue.push(job);
        pump(keys);
        if (!sync) return json(res, 202, { id });
        while (job.state === "queued" || job.state === "running") await new Promise((r) => setTimeout(r, 400));
        if (job.state !== "done") return json(res, 200, { state: job.state, error: job.error ?? "Reading stopped." });
        const images = (await pageImages(job)).map((png) => `data:image/png;base64,${Buffer.from(png).toString("base64")}`);
        return json(res, 200, {
          state: "done",
          phase: job.phase,
          progress: 1,
          pages: job.pages,
          seconds: Math.round(((job.finished ?? Date.now()) - job.started) / 1000),
          queuePosition: 0,
          error: null,
          pieces: job.pieces,
          pageCount: images.length,
          pageImages: images,
          layout: job.layout ?? null,
          ai: job.ai ?? null,
          aiError: job.aiError ?? null,
        });
      }
      const m = /^\/api\/read\/([0-9a-f-]{36})(?:\/(page)\/(\d+)|\/(cancel))?$/.exec(url.pathname);
      const job = m && jobs.get(m[1]);
      if (m && !job) return json(res, 404, { error: "That reading is no longer available. Please try again." });
      if (job && m[4] && req.method === "POST") {
        const i = queue.indexOf(job);
        if (i >= 0) queue.splice(i, 1);
        job.state = "cancelled";
        job.finished = Date.now();
        job.child?.kill("SIGKILL");
        return json(res, 200, { state: job.state });
      }
      if (job && m[2]) {
        const png = (await pageImages(job))[Number(m[3]) - 1];
        if (!png) return json(res, 404, { error: "No such page" });
        res.statusCode = 200;
        res.setHeader("Content-Type", "image/png");
        return res.end(Buffer.from(png));
      }
      if (job && req.method === "GET") {
        return json(res, 200, {
          state: job.state,
          phase: job.phase,
          progress: progressOf(job),
          pages: job.pages,
          seconds: Math.round(((job.finished ?? Date.now()) - job.started) / 1000),
          queuePosition: job.state === "queued" ? queue.indexOf(job) + 1 : 0,
          error: job.error ?? null,
          ...(job.state === "done" ? { pieces: job.pieces, pageCount: job.pageCount ?? 0, layout: job.layout ?? null, ai: job.ai ?? null, aiError: job.aiError ?? null } : {}),
        });
      }
      return json(res, 404, { error: "Not found" });
    } catch (error) {
      return json(res, error?.message === "too-large" ? 413 : 500, { error: error?.message === "too-large" ? "That file is over 40 MB." : String(error) });
    }
  };
}

/** Vite plugin: mounts the API on the dev and preview servers. */
export function snapPlayServer(keys) {
  const handle = createHandler(keys);
  return {
    name: "snap-play-server",
    configureServer(server) {
      server.middlewares.use(handle);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handle);
    },
  };
}
