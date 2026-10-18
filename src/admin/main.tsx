// admin.tryfermata.app: Fermata's analytics, behind one password (api/admin.mjs).
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./admin.css";

interface Day {
  day: string;
  visitors: number;
  [event: string]: number | string;
}
interface Stats {
  days: number;
  daily: Day[];
  visitors: number;
  totals: Record<string, number>;
  countries: Record<string, number>;
  devices: Record<string, number>;
  referrers: Record<string, number>;
  fails: { t: number; kind: string; seconds: number; error: string }[];
}

type State = { kind: "loading" } | { kind: "login"; error?: string } | { kind: "setup" } | { kind: "error"; message: string } | { kind: "ready"; stats: Stats };

const n = (v: unknown) => (typeof v === "number" ? v : 0);
const fmt = (v: number) => v.toLocaleString();

async function load(days: number): Promise<State> {
  // While developing, /admin.html?demo shows made-up numbers (the API only runs on Vercel).
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("demo")) return { kind: "ready", stats: demo(days) };
  const res = await fetch(`/api/admin?days=${days}`, { cache: "no-store" });
  if (res.status === 401) return { kind: "login" };
  const body = await res.json().catch(() => ({}));
  if (res.status === 503 && body.error === "storage") return { kind: "setup" };
  if (!res.ok) return { kind: "error", message: body.error ?? `Something went wrong (${res.status}).` };
  return { kind: "ready", stats: body };
}

function App() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [days, setDays] = useState(30);
  const refresh = (d = days) => void load(d).then(setState, (e: Error) => setState({ kind: "error", message: e.message }));
  useEffect(() => refresh(), []); // eslint-disable-line react-hooks/exhaustive-deps

  if (state.kind === "loading") return <main className="center"><p className="muted">Loading…</p></main>;
  if (state.kind === "login") return <Login error={state.error} onDone={() => refresh()} />;

  const signOut = async () => {
    await fetch("/api/admin?do=logout", { method: "POST" });
    setState({ kind: "login" });
  };

  return (
    <main className="dash">
      <header className="dash-head">
        <div className="brand">
          <img src="/brand/wordmark.png" alt="Fermata" />
          <span>Admin</span>
        </div>
        <div className="head-actions">
          <div className="seg" role="group" aria-label="Time range">
            {[7, 30, 90].map((d) => (
              <button
                key={d}
                className={d === days ? "on" : ""}
                aria-pressed={d === days}
                onClick={() => {
                  setDays(d);
                  refresh(d);
                }}
              >
                {d} days
              </button>
            ))}
          </div>
          <button className="ghost" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>
      {state.kind === "setup" ? <Setup /> : state.kind === "error" ? <p className="error">{state.message}</p> : <Dashboard s={state.stats} />}
    </main>
  );
}

function Login({ error, onDone }: { error?: string; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState(error ?? "");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    const res = await fetch("/api/admin?do=login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) onDone();
    else setMessage(body.error ?? "Couldn't sign in.");
  };
  return (
    <main className="center">
      <form className="login" onSubmit={(e) => void submit(e)}>
        <img src="/brand/wordmark.png" alt="Fermata" />
        <h1>Admin</h1>
        <label htmlFor="pw">Password</label>
        <input id="pw" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        <button type="submit" disabled={busy || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        {message ? (
          <p className="error" role="alert">
            {message}
          </p>
        ) : null}
      </form>
    </main>
  );
}

function Setup() {
  return (
    <section className="card setup">
      <h2>Connect analytics storage</h2>
      <p>You're signed in, but there's nowhere to keep the numbers yet.</p>
      <ol>
        <li>The numbers live in Firestore on Google Cloud (fermata-stats service), reached with <strong>READER_SECRET</strong>.</li>
        <li>Check that READER_SECRET is set in Vercel, then redeploy.</li>
      </ol>
    </section>
  );
}

const FEATURES: [string, string][] = [
  ["camera", "Opened the camera"],
  ["upload", "Sent a photo or PDF"],
  ["sample", "Tried the sample song"],
  ["recent", "Reopened a recent reading"],
  ["play", "Pressed play"],
  ["sing", "Opened “sing this note”"],
  ["tuner", "Opened the tuner"],
  ["warmups", "Opened warm-ups"],
  ["warmup_done", "Finished a warm-up"],
];

function Dashboard({ s }: { s: Stats }) {
  const t = s.totals;
  const ok = n(t.read_ok);
  const failed = n(t.read_fail);
  const reads = ok + failed;
  const rate = reads ? Math.round((ok / reads) * 100) : null;
  const avg = reads ? Math.round(n(t.read_seconds) / reads) : null;
  return (
    <>
      <section className="tiles">
        <Tile label="Visitors" value={fmt(s.visitors)} foot={`daily uniques, last ${s.days} days`} />
        <Tile label="Visits" value={fmt(n(t.view))} foot="app opens" />
        <Tile label="Readings" value={fmt(reads)} foot={rate === null ? "none yet" : `${rate}% read OK`} />
        <Tile label="Reading time" value={avg === null ? "–" : `${avg}s`} foot="average" />
      </section>

      <section className="card">
        <h2>Visitors per day</h2>
        <Bars daily={s.daily} series={[{ key: "visitors", label: "Visitors", color: "var(--c1)" }]} />
      </section>

      <section className="card">
        <h2>Readings per day</h2>
        <Bars
          daily={s.daily}
          series={[
            { key: "read_ok", label: "Read OK", color: "var(--c1)" },
            { key: "read_fail", label: "Failed", color: "var(--c2)" },
          ]}
        />
        <p className="note">
          {fmt(n(t.read_photo))} photos · {fmt(n(t.read_pdf))} PDFs · {fmt(n(t.read_reader))} by the music reader · {fmt(n(t.read_ai))} by the AI after the reader failed
        </p>
      </section>

      <div className="grid2">
        <section className="card">
          <h2>What people use</h2>
          <List rows={FEATURES.map(([k, label]) => [label, n(t[k])])} />
        </section>
        <section className="card">
          <h2>Countries</h2>
          <List rows={top(s.countries).map(([c, v]) => [`${flag(c)} ${countryName(c)}`, v])} empty="No visits yet" />
        </section>
        <section className="card">
          <h2>Devices</h2>
          <List rows={top(s.devices).map(([d, v]) => [d[0].toUpperCase() + d.slice(1), v])} empty="No visits yet" />
        </section>
        <section className="card">
          <h2>Where visitors came from</h2>
          <List rows={top(s.referrers).map(([r, v]) => [r, v])} empty="No links from other sites yet" />
        </section>
      </div>

      <section className="card">
        <h2>Recent failed readings</h2>
        {s.fails.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Kind</th>
                  <th>Time</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {s.fails.map((f, i) => (
                  <tr key={i}>
                    <td>{new Date(f.t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
                    <td>{f.kind}</td>
                    <td>{f.seconds}s</td>
                    <td>{f.error || "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">None. Every reading has worked.</p>
        )}
      </section>
    </>
  );
}

function Tile({ label, value, foot }: { label: string; value: string; foot: string }) {
  return (
    <div className="tile">
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
      <span className="tile-foot">{foot}</span>
    </div>
  );
}

const top = (o: Record<string, number>, k = 8) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, k);

function List({ rows, empty = "Nothing yet" }: { rows: [string, number][]; empty?: string }) {
  const max = Math.max(1, ...rows.map((r) => r[1]));
  if (!rows.length || rows.every((r) => !r[1])) return <p className="muted">{empty}</p>;
  return (
    <ul className="list">
      {rows.map(([label, v]) => (
        <li key={label}>
          <span className="list-bar" style={{ width: `${(v / max) * 100}%` }} aria-hidden />
          <span className="list-label">{label}</span>
          <span className="list-value">{fmt(v)}</span>
        </li>
      ))}
    </ul>
  );
}

const regionNames = typeof Intl !== "undefined" && "DisplayNames" in Intl ? new Intl.DisplayNames(undefined, { type: "region" }) : null;
const countryName = (c: string) => {
  try {
    return c === "??" ? "Unknown" : (regionNames?.of(c) ?? c);
  } catch {
    return c;
  }
};
const flag = (c: string) => (/^[A-Z]{2}$/.test(c) ? String.fromCodePoint(...[...c].map((ch) => 0x1f1a5 + ch.charCodeAt(0))) : "🌐");

/** Daily bars (stacked when there are two series), with a hover/tap tooltip per day. */
function Bars({ daily, series }: { daily: Day[]; series: { key: string; label: string; color: string }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  // Drawn at the box's real width, so text stays the same size on a phone and a laptop.
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(720);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = W < 480 ? 160 : 200;
  const top = 12;
  const bottom = 24;
  const totals = daily.map((d) => series.reduce((sum, s) => sum + n(d[s.key]), 0));
  const max = Math.max(1, ...totals);
  const nice = niceMax(max);
  const gutter = 30; // room for the scale numbers on the right
  const slot = (W - gutter) / daily.length;
  const bw = Math.max(3, Math.min(22, slot - 3));
  const y = (v: number) => top + (H - top - bottom) * (1 - v / nice);
  const label = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const h = hover === null ? null : daily[hover];
  return (
    <div className="chart" ref={box}>
      {series.length > 1 ? (
        <div className="legend">
          {series.map((s) => (
            <span key={s.key}>
              <i style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      ) : null}
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${series.map((s) => s.label).join(" and ")} per day. Highest: ${max}.`} onMouseLeave={() => setHover(null)}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line className="grid" x1={0} x2={W - gutter} y1={y(nice * f)} y2={y(nice * f)} />
            <text className="axis" x={W} y={y(nice * f) + 4} textAnchor="end">
              {Math.round(nice * f)}
            </text>
          </g>
        ))}
        {daily.map((d, i) => {
          let base = 0;
          const x = i * slot + (slot - bw) / 2;
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)} onClick={() => setHover(i)}>
              <rect className="hit" x={i * slot} y={0} width={slot} height={H - bottom} />
              {series.map((s, si) => {
                const v = n(d[s.key]);
                if (!v) return null;
                const y0 = y(base);
                base += v;
                const y1 = y(base);
                const isTop = series.slice(si + 1).every((later) => !n(d[later.key]));
                // 2px gap between stacked segments; only the top segment gets rounded ends.
                const height = Math.max(1, y0 - y1 - (si > 0 ? 2 : 0));
                return <rect key={s.key} x={x} y={y1} width={bw} height={height} rx={isTop ? Math.min(4, bw / 2) : 0} fill={s.color} opacity={hover === null || hover === i ? 1 : 0.45} />;
              })}
            </g>
          );
        })}
        <line className="baseline" x1={0} x2={W - gutter} y1={y(0)} y2={y(0)} />
        {[0, Math.floor(daily.length / 2), daily.length - 1].map((i) => (
          <text key={i} className="axis" x={i * slot + slot / 2} y={H - 6} textAnchor={i === 0 ? "start" : i === daily.length - 1 ? "end" : "middle"}>
            {label(daily[i].day)}
          </text>
        ))}
      </svg>
      {h ? (
        <div className="tip" style={{ left: `${(((hover! + 0.5) * slot) / W) * 100}%` }} role="status">
          <strong>{label(h.day)}</strong>
          {series.map((s) => (
            <span key={s.key}>
              <i style={{ background: s.color }} />
              {s.label}: {fmt(n(h[s.key]))}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function niceMax(v: number) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function demo(days: number): Stats {
  const daily: Day[] = Array.from({ length: days }, (_, i) => {
    const day = new Date(Date.now() - (days - 1 - i) * 864e5).toISOString().slice(0, 10);
    const v = Math.round(20 + i * 1.6 + 10 * Math.sin(i / 2));
    return { day, visitors: v, view: v + 9, read_ok: Math.round(v / 4), read_fail: i % 5 === 0 ? 2 : i % 3 === 0 ? 1 : 0 };
  });
  const sum = (k: string) => daily.reduce((a, d) => a + n(d[k]), 0);
  return {
    days,
    daily,
    visitors: Math.round(sum("visitors") * 0.7),
    totals: { view: sum("view"), read_ok: sum("read_ok"), read_fail: sum("read_fail"), read_seconds: (sum("read_ok") + sum("read_fail")) * 52, read_photo: 140, read_pdf: 61, read_reader: 180, read_ai: 15, camera: 120, upload: 190, sample: 240, recent: 44, play: 410, sing: 58, tuner: 160, warmups: 130, warmup_done: 86 },
    countries: { CA: 210, US: 160, GB: 40, AU: 22, PH: 9 },
    devices: { phone: 330, computer: 120, tablet: 18 },
    referrers: { "instagram.com": 120, "tiktok.com": 64, "google.com": 21 },
    fails: [{ t: Date.now() - 36e5, kind: "photo", seconds: 92, error: "The AI couldn't read that page: no music found" }],
  };
}

createRoot(document.getElementById("root")!).render(<App />);
