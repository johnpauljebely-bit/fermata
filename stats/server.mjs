// fermata-stats: stores Fermata's anonymous analytics in Firestore (free tier). Runs on
// Google Cloud Run; only Fermata's own server (Vercel) talks to it, with the shared secret.
//
//   days/{YYYY-MM-DD}                 counts for the day (events, readings, countries, devices, referrers)
//   days/{YYYY-MM-DD}/visitors/{id}   one doc per daily visitor hash (counted, never read back)
//   fails/{auto}                      failed readings: time, kind, seconds, message
//   logins/{ip hash}                  admin sign-in attempts (rate limit)
import http from "node:http";
import { Firestore, FieldValue } from "@google-cloud/firestore";

const db = new Firestore({ ignoreUndefinedProperties: true });
const SECRET = process.env.STATS_SECRET ?? "";
const inc = (n = 1) => FieldValue.increment(n);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const clean = (s, n) => String(s ?? "").slice(0, n);
/** Firestore deletes records once this date passes (a TTL policy on "expires"): ~13 months. */
const expires = () => new Date(Date.now() + 400 * 864e5);

async function event({ day, name, visitor }) {
  if (!DAY.test(day) || !/^[a-z_]{1,20}$/.test(name)) return;
  const doc = { [name]: inc() };
  if (visitor) {
    const { id, country, device, ref } = visitor;
    if (/^[0-9a-f]{8,64}$/.test(id ?? "")) await db.doc(`days/${day}/visitors/${id}`).set({ expires: expires() });
    doc.countries = { [clean(country, 2) || "??"]: inc() };
    doc.devices = { [clean(device, 10) || "unknown"]: inc() };
    if (ref) doc.referrers = { [clean(ref, 60)]: inc() };
  }
  await db.doc(`days/${day}`).set({ ...doc, expires: expires() }, { merge: true });
}

async function reading({ day, ok, how, kind, seconds, error }) {
  if (!DAY.test(day)) return;
  const k = kind === "pdf" ? "pdf" : "photo";
  const h = ["reader", "ai", "none"].includes(how) ? how : "none";
  await db.doc(`days/${day}`).set({ [ok ? "read_ok" : "read_fail"]: inc(), [`read_${h}`]: inc(), [`read_${k}`]: inc(), read_seconds: inc(Math.round(Number(seconds) || 0)), expires: expires() }, { merge: true });
  if (!ok) await db.collection("fails").add({ t: Date.now(), kind: k, seconds: Math.round(Number(seconds) || 0), error: clean(error, 200), expires: expires() });
}

async function stats(days) {
  const dates = [];
  for (let i = days - 1; i >= 0; i--) dates.push(new Date(Date.now() - i * 864e5).toISOString().slice(0, 10));
  const snaps = await db.getAll(...dates.map((d) => db.doc(`days/${d}`)));
  const uniques = await Promise.all(dates.map((d) => db.collection(`days/${d}/visitors`).count().get().then((s) => s.data().count)));
  const countries = {};
  const devices = {};
  const referrers = {};
  const add = (into, from) => {
    for (const [k, v] of Object.entries(from ?? {})) into[k] = (into[k] ?? 0) + v;
  };
  const daily = dates.map((day, i) => {
    const { countries: c, devices: d, referrers: r, expires: _e, ...counts } = snaps[i].data() ?? {};
    add(countries, c);
    add(devices, d);
    add(referrers, r);
    return { day, visitors: uniques[i], ...counts };
  });
  const totals = {};
  for (const { day, visitors, ...c } of daily) add(totals, c);
  const fails = (await db.collection("fails").orderBy("t", "desc").limit(50).get()).docs.map((d) => {
    const { expires: _e, ...f } = d.data();
    return f;
  });
  return { days, daily, visitors: uniques.reduce((a, b) => a + b, 0), totals, countries, devices, referrers, fails };
}

/** At most 8 admin sign-in attempts per 15 minutes from one place. */
async function loginAllowed({ who }) {
  if (!/^[0-9a-f]{8,64}$/.test(who ?? "")) return false;
  const ref = db.doc(`logins/${who}`);
  return db.runTransaction(async (tx) => {
    const now = Date.now();
    const cur = (await tx.get(ref)).data();
    const fresh = !cur || now - cur.since > 15 * 60 * 1000;
    const count = fresh ? 1 : cur.count + 1;
    tx.set(ref, { since: fresh ? now : cur.since, count, expires: new Date(now + 864e5) });
    return count <= 8;
  });
}

const send = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(body === undefined ? "" : JSON.stringify(body));
};

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      if (url.pathname === "/") return send(res, 200, { ok: true });
      if (!SECRET || req.headers["x-fermata-key"] !== SECRET) return send(res, 403, { error: "Not allowed." });
      let body = {};
      if (req.method === "POST") {
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 10_000) return send(res, 413, { error: "Too big." });
        }
        body = JSON.parse(raw || "{}");
      }
      if (req.method === "POST" && url.pathname === "/event") return (await event(body), send(res, 204));
      if (req.method === "POST" && url.pathname === "/reading") return (await reading(body), send(res, 204));
      if (req.method === "POST" && url.pathname === "/login") return send(res, 200, { allowed: await loginAllowed(body) });
      if (req.method === "GET" && url.pathname === "/stats") return send(res, 200, await stats(Math.min(90, Math.max(7, Number(url.searchParams.get("days")) || 30))));
      send(res, 404, { error: "Not found." });
    } catch (error) {
      console.error(error);
      send(res, 500, { error: "Something went wrong." });
    }
  })
  .listen(Number(process.env.PORT) || 8080, () => console.log("fermata-stats ready"));
