// Fermata's own privacy-friendly analytics, kept in Firestore (Google Cloud's free tier) by a
// tiny service, fermata-stats (stats/). No cookies for visitors, no IP addresses stored: only
// daily counts, the country and device type, the referring site, and a visitor hash that
// changes every day (so nobody can be followed from one day to the next).
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const STATS = (process.env.STATS_URL ?? "https://fermata-stats-857586098260.us-central1.run.app").replace(/\/$/, "");
// The reader's secret doubles as the stats service's, so Vercel needs nothing new.
const SECRET = process.env.STATS_SECRET ?? process.env.READER_SECRET ?? "";
export const storageReady = () => !!(STATS && SECRET);

/** Events the app may send (anything else is ignored). */
export const EVENTS = [
  "view", // a visit to the app
  "camera", // opened the camera
  "upload", // picked a photo/PDF
  "sample", // opened the sample song
  "recent", // reopened a recent reading
  "play", // pressed play on a score
  "sing", // opened "sing this note"
  "tuner", // opened the tuner
  "warmups", // opened warm-ups
  "warmup_done", // finished a warm-up
];

/** Talks to the stats service. */
async function call(path, body) {
  if (!storageReady()) return null;
  const res = await fetch(`${STATS}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-fermata-key": SECRET, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Analytics store answered ${res.status}`);
  return res.status === 204 ? null : res.json();
}

export const today = (d = new Date()) => d.toISOString().slice(0, 10);

const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|headless|lighthouse|monitor/i;

/** What we note about a visitor: country and device from the request, nothing else kept. */
function visitor(request) {
  const h = request.headers;
  const ua = h.get("user-agent") ?? "";
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0].trim();
  const day = today();
  const salt = process.env.ANALYTICS_SALT ?? process.env.ADMIN_PASSWORD ?? "fermata";
  return {
    bot: BOT.test(ua) || !ua,
    day,
    // A daily-rotating hash: counts unique visitors per day, can't be reversed or linked across days.
    id: createHash("sha256").update(`${salt}|${day}|${ip}|${ua}`).digest("hex").slice(0, 24),
    country: (h.get("x-vercel-ip-country") ?? "").toUpperCase().slice(0, 2) || "??",
    device: /iPad|Tablet/i.test(ua) ? "tablet" : /Mobi|iPhone|Android/i.test(ua) ? "phone" : "computer",
  };
}

/** Counts one app event. Never throws (analytics must not break the app). */
export async function track(request, name, extra = {}) {
  try {
    if (!storageReady() || !EVENTS.includes(name)) return;
    const v = visitor(request);
    if (v.bot) return;
    await call("/event", {
      day: v.day,
      name,
      visitor: name === "view" ? { id: v.id, country: v.country, device: v.device, ref: cleanReferrer(extra.ref) ?? undefined } : undefined,
    });
  } catch {
    // ignore
  }
}

/** Only the referring site's name (e.g. "instagram.com"), never the full address. */
function cleanReferrer(ref) {
  try {
    const host = new URL(String(ref)).hostname.replace(/^www\./, "").toLowerCase();
    if (!host || /tryfermata\.app$|vercel\.app$|localhost/.test(host)) return null;
    return host.slice(0, 60);
  } catch {
    return null;
  }
}

/** Records how a reading went (from the server, so it's always counted). No image, no visitor. */
export async function trackReading(request, { ok, how, kind, seconds, error }) {
  try {
    await call("/reading", { day: today(), ok, how, kind, seconds, error: String(error ?? "").slice(0, 200) });
  } catch {
    // ignore
  }
}

/** Everything the admin page shows, for the last `days` days. */
export const stats = (days = 30) => call(`/stats?days=${days}`);

// ---------- the admin password ----------

const sha = (s) => createHash("sha256").update(s).digest();
/** Signing key changes with the password, so changing it signs everyone out. */
const key = () => sha(`fermata-admin|${process.env.ADMIN_PASSWORD ?? ""}`);
export const adminReady = () => (process.env.ADMIN_PASSWORD ?? "").length >= 8;

export function passwordMatches(given) {
  if (!adminReady()) return false;
  return timingSafeEqual(sha(String(given ?? "")), sha(process.env.ADMIN_PASSWORD));
}

const WEEK = 7 * 24 * 3600;
export function sessionCookie() {
  const exp = Math.floor(Date.now() / 1000) + WEEK;
  const sig = createHmac("sha256", key()).update(String(exp)).digest("base64url");
  return `fa_admin=${exp}.${sig}; Path=/; Max-Age=${WEEK}; HttpOnly; Secure; SameSite=Strict`;
}
export const clearCookie = () => "fa_admin=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict";

export function signedIn(request) {
  if (!adminReady()) return false;
  const m = /(?:^|;\s*)fa_admin=(\d+)\.([\w-]+)/.exec(request.headers.get("cookie") ?? "");
  if (!m || Number(m[1]) < Date.now() / 1000) return false;
  const want = createHmac("sha256", key()).update(m[1]).digest();
  const got = Buffer.from(m[2], "base64url");
  return got.length === want.length && timingSafeEqual(got, want);
}

/** At most 8 sign-in attempts per 15 minutes from one place (counted by the stats service). */
export async function loginAllowed(request) {
  const ip = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  const who = createHash("sha256").update(`login|${ip}`).digest("hex").slice(0, 24);
  const r = await call("/login", { who }).catch(() => null);
  return !r || r.allowed;
}
