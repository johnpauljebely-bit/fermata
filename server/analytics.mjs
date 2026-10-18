// Fermata's own privacy-friendly analytics, kept in a small Redis (Upstash, via Vercel's
// Storage tab). No cookies for visitors, no IP addresses stored: only daily counts, the
// country and device type, the referring site, and a visitor hash that changes every day
// (so nobody can be followed from one day to the next).
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const URL_ = (process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL ?? "").replace(/\/$/, "");
const TOKEN = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN ?? "";
export const storageReady = () => !!(URL_ && TOKEN);

/** Day keys live ~13 months. */
const TTL = 400 * 24 * 3600;

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

/** Runs Redis commands in one round trip. Returns their results (or null without storage). */
export async function redis(commands) {
  if (!storageReady() || !commands.length) return null;
  const res = await fetch(`${URL_}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`Analytics storage answered ${res.status}`);
  return (await res.json()).map((r) => r.result);
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
    const d = `fa:d:${v.day}`;
    const cmds = [["HINCRBY", d, name, 1], ["EXPIRE", d, TTL]];
    if (name === "view") {
      cmds.push(["PFADD", `fa:u:${v.day}`, v.id], ["EXPIRE", `fa:u:${v.day}`, TTL]);
      cmds.push(["HINCRBY", `fa:c:${v.day}`, v.country, 1], ["EXPIRE", `fa:c:${v.day}`, TTL]);
      cmds.push(["HINCRBY", `fa:dev:${v.day}`, v.device, 1], ["EXPIRE", `fa:dev:${v.day}`, TTL]);
      const ref = cleanReferrer(extra.ref);
      if (ref) cmds.push(["HINCRBY", `fa:r:${v.day}`, ref, 1], ["EXPIRE", `fa:r:${v.day}`, TTL]);
    }
    await redis(cmds);
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

/** Records how a reading went (from the server, so it's always counted). */
export async function trackReading(request, { ok, how, kind, seconds, error }) {
  try {
    if (!storageReady()) return;
    const day = today();
    const d = `fa:d:${day}`;
    const cmds = [
      ["HINCRBY", d, ok ? "read_ok" : "read_fail", 1],
      ["HINCRBY", d, `read_${how}`, 1], // reader / ai / none
      ["HINCRBY", d, `read_${kind}`, 1], // photo / pdf
      ["HINCRBY", d, "read_seconds", Math.round(seconds)],
      ["EXPIRE", d, TTL],
    ];
    if (!ok) {
      // The last 50 failures: when, what kind, how long and the message. No image, no visitor.
      cmds.push(["LPUSH", "fa:fails", JSON.stringify({ t: Date.now(), kind, seconds: Math.round(seconds), error: String(error ?? "").slice(0, 200) })]);
      cmds.push(["LTRIM", "fa:fails", 0, 49]);
    }
    await redis(cmds);
  } catch {
    // ignore
  }
}

const toObject = (flat) => {
  const o = {};
  for (let i = 0; flat && i < flat.length; i += 2) o[flat[i]] = Number(flat[i + 1]);
  return o;
};
const merge = (objs) => {
  const out = {};
  for (const o of objs) for (const [k, v] of Object.entries(o)) out[k] = (out[k] ?? 0) + v;
  return out;
};

/** Everything the admin page shows, for the last `days` days. */
export async function stats(days = 30) {
  const dates = [];
  for (let i = days - 1; i >= 0; i--) dates.push(today(new Date(Date.now() - i * 864e5)));
  const per = ["fa:d", "fa:u", "fa:c", "fa:dev", "fa:r"];
  const cmds = [];
  for (const day of dates) {
    cmds.push(["HGETALL", `fa:d:${day}`], ["PFCOUNT", `fa:u:${day}`], ["HGETALL", `fa:c:${day}`], ["HGETALL", `fa:dev:${day}`], ["HGETALL", `fa:r:${day}`]);
  }
  cmds.push(["PFCOUNT", ...dates.map((d) => `fa:u:${d}`)]);
  cmds.push(["LRANGE", "fa:fails", 0, 49]);
  const r = await redis(cmds);
  const daily = dates.map((day, i) => {
    const counts = toObject(r[i * per.length]);
    return { day, visitors: Number(r[i * per.length + 1] ?? 0), ...counts };
  });
  const pick = (k) => merge(dates.map((_, i) => toObject(r[i * per.length + k])));
  return {
    days,
    daily,
    visitors: Number(r[dates.length * per.length] ?? 0), // unique across the range
    totals: merge(daily.map(({ day, visitors, ...c }) => c)),
    countries: pick(2),
    devices: pick(3),
    referrers: pick(4),
    fails: (r[dates.length * per.length + 1] ?? []).map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    }).filter(Boolean),
  };
}

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

/** At most 8 sign-in attempts per 15 minutes from one place. */
export async function loginAllowed(request) {
  const ip = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  const k = `fa:login:${createHash("sha256").update(ip).digest("hex").slice(0, 16)}`;
  const r = await redis([["INCR", k], ["EXPIRE", k, 900, "NX"]]).catch(() => null);
  return !r || Number(r[0]) <= 8;
}
