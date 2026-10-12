import { useEffect, useRef, useState } from "react";
import { cancelReading, getStatus, readProgress, shrinkPhoto, startReading, type AIAnswer, type ReadProgress, type Status } from "./api";

/** Uploads in flight, by the temporary id the reading screen starts with. */
const uploads = new Map<string, Promise<{ id: string } | ReadProgress>>();
import { prefetchPiano } from "./audio/piano";
import { applyCheck, mergeScores, transcriptionToXml } from "./music/xml";
import { ScoreScreen, type ScoreInfo } from "./ScoreScreen";
import { TunerTab } from "./TunerTab";
import { WarmupsTab } from "./WarmupsTab";
import { BackButton, Dial, Ruler } from "./ui";

type Tab = "play" | "tuner" | "warmups";

type Screen =
  | { kind: "home" }
  | { kind: "reading"; id: string; preview: string | null; name: string }
  | { kind: "score"; xml: string; info: ScoreInfo };

export function App() {
  // #read=<id> survives a refresh (or the phone locking) while the Mac is still reading.
  const [screen, setScreenState] = useState<Screen>(() => {
    const id = /read=([0-9a-f-]{36})/.exec(location.hash)?.[1];
    return id ? { kind: "reading", id, preview: null, name: "" } : { kind: "home" };
  });
  const setScreen = (next: Screen) => {
    // Only real reading ids go in the address (temporary upload ids can't be reopened).
    const realId = (id: string) => (/^[0-9a-f-]{36}$/.test(id) ? id : null);
    const id = next.kind === "reading" ? realId(next.id) : next.kind === "score" && next.info.pages ? realId(next.info.pages.jobId) : null;
    const hash = id ? `#read=${id}` : "";
    history.replaceState(null, "", hash || location.pathname + location.search);
    setScreenState(next);
  };
  const [status, setStatus] = useState<Status | null>(null);
  const [tab, setTab] = useState<Tab>("play");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getStatus().then(setStatus, () => setStatus(null));
    void prefetchPiano().catch(() => undefined);
  }, []);

  const read = (file: File) => {
    setError(null);
    const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
    // Show the reading screen straight away; the upload (and, on Vercel, the whole reading)
    // happens behind it. Hosted uploads are shrunk to fit Vercel's request limit.
    const key = `upload-${Date.now()}`;
    uploads.set(key, (status?.hosted ? shrinkPhoto(file) : Promise.resolve(file)).then(startReading));
    setScreen({ kind: "reading", id: key, preview, name: file.name.replace(/\.[^.]+$/, "") });
  };

  const openSample = async () => {
    const xml = await fetch("/twinkle-twinkle.musicxml").then((r) => r.text());
    setScreen({ kind: "score", xml, info: { title: "Twinkle, Twinkle, Little Star", source: "sample" } });
  };

  let page: React.ReactNode;
  if (tab === "tuner") page = <TunerTab />;
  else if (tab === "warmups") page = <WarmupsTab />;
  else if (screen.kind === "reading")
    page = (
      <Reading
        {...screen}
        onCancel={() => {
          void cancelReading(screen.id);
          setScreen({ kind: "home" });
        }}
        onFail={(message) => {
          setError(message);
          setScreen({ kind: "home" });
        }}
        onDone={(xml, info) => setScreen({ kind: "score", xml, info })}
      />
    );
  else if (screen.kind === "score") page = <ScoreScreen xml={screen.xml} info={screen.info} onBack={() => setScreen({ kind: "home" })} />;
  else page = <Home status={status} error={error} onFile={read} onSample={openSample} />;

  // The tab bar sits under the top-level pages; a score or a reading has the screen to itself.
  const showTabs = tab !== "play" || screen.kind === "home";
  return (
    <div className={showTabs ? "has-tabs" : ""}>
      {page}
      {showTabs ? <TabBar tab={tab} onTab={setTab} /> : null}
    </div>
  );
}

function TabBar({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  const items: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "play", label: "Play", icon: <NoteIcon /> },
    {
      id: "tuner",
      label: "Tuner",
      icon: (
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
          <path d="M3.5 16a8.5 8.5 0 0 1 17 0" />
          <path d="M12 16l4-6" />
        </svg>
      ),
    },
    {
      id: "warmups",
      label: "Warm-ups",
      icon: (
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
          <path d="M3 17c2.5 0 2.5-5 5-5s2.5 3 5 3 2.5-8 5-8 2.5 4 3 4" />
        </svg>
      ),
    },
  ];
  return (
    <nav className="tabbar" aria-label="Sections">
      {items.map((it) => (
        <button key={it.id} className={tab === it.id ? "on" : ""} aria-current={tab === it.id ? "page" : undefined} onClick={() => onTab(it.id)}>
          <i>{it.icon}</i>
          <span>{it.label}</span>
        </button>
      ))}
    </nav>
  );
}

// ---------- home ----------

function Home({ status, error, onFile, onSample }: { status: Status | null; error: string | null; onFile: (f: File) => void; onSample: () => void }) {
  const camera = useRef<HTMLInputElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (f) onFile(f);
  };
  const ai = status ? [status.ai.gemini && "Gemini", status.ai.groq && "Groq"].filter(Boolean).join(" + ") : "";

  return (
    <main className="home">
      <header className="home-head">
        <img className="brand" src="/brand/wordmark.png" alt="Fermata" />
        <span className="home-sub">Sheet music → piano</span>
      </header>

      <div className="bento">
        {/* The "Reminder" card: pink bloom, dot-matrix word in the dark core. */}
        <button className="tile g-bloom tile-hero" onClick={() => camera.current?.click()}>
          <span className="tile-label">Take a photo</span>
          <span className="tile-core">
            <span className="dots dots-xl">snap</span>
            <span className="tile-unit">any page</span>
          </span>
          <Ruler value={0} />
          <span className="tile-foot">Camera opens · hold the page flat</span>
        </button>

        {/* The sensor card: sage glow, dial of ticks, white button. */}
        <button className="tile g-sage tile-pick" onClick={() => files.current?.click()}>
          <span className="tile-label">PDF or picture</span>
          <Dial size={132} ticks={60} progress={0}>
            <span className="knob">
              <DocIcon />
            </span>
          </Dial>
        </button>

        <button className="tile g-glucose tile-sample" onClick={onSample}>
          <span className="tile-label">Try a song</span>
          <span className="tile-value">
            <span className="dots dots-l">12</span>
            <span className="tile-unit">bars</span>
          </span>
          <span className="tile-foot">Twinkle, Twinkle</span>
        </button>

        <div className="tile g-ink tile-status" role="status">
          <span className="tile-label">Ready</span>
          {status === null ? (
            <span className="tile-foot">Can't reach the server</span>
          ) : (
            <ul className="status-list">
              {status.hosted ? null : (
                <li>
                  <span>Reader</span>
                  <span className={`chip-on ${status.reader ? "on" : ""}`}>{status.reader ? "ON" : "OFF"}</span>
                </li>
              )}
              <li>
                <span>{ai || "AI"}</span>
                <span className={`chip-on ${ai ? "on" : ""}`}>{ai ? "ON" : "OFF"}</span>
              </li>
            </ul>
          )}
        </div>
      </div>

      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={pick} />
      <input ref={files} type="file" accept="application/pdf,image/*" hidden onChange={pick} />
    </main>
  );
}

// ---------- reading ----------

const PHASES: { key: ReadProgress["phase"][]; label: string }[] = [
  { key: ["queued", "prepare"], label: "Looking at the page" },
  { key: ["straighten"], label: "Straightening the lines" },
  { key: ["recognize"], label: "Reading every note" },
  { key: ["ai"], label: "AI checking the signs" },
];

function Reading({
  id,
  preview,
  name,
  onCancel,
  onFail,
  onDone,
}: {
  id: string;
  preview: string | null;
  name: string;
  onCancel: () => void;
  onFail: (message: string) => void;
  onDone: (xml: string, info: ScoreInfo) => void;
}) {
  const [p, setP] = useState<ReadProgress | null>(null);
  const done = useRef(false);

  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    let alive = true;
    let jobId: string | null = id.startsWith("upload-") ? null : id;
    const started = Date.now();
    const clock = setInterval(() => alive && setElapsed((Date.now() - started) / 1000), 500);

    const handle = (next: ReadProgress): boolean => {
      setP(next);
      if (next.state === "done" && !done.current) {
        done.current = true;
        try {
          const { xml, info } = finish(next, name, jobId ?? id);
          onDone(xml, info);
        } catch (e) {
          onFail((e as Error).message);
        }
        return true;
      }
      if (next.state === "error") {
        onFail(next.error ?? "Couldn't read that.");
        return true;
      }
      return next.state === "cancelled";
    };

    const tick = async () => {
      try {
        if (!jobId) {
          // Waiting for the upload: on your Mac it answers with a job id, on Vercel with the result.
          const answer = await uploads.get(id);
          uploads.delete(id);
          if (!alive) return;
          if (!answer) return onFail("That reading is no longer available. Please try again.");
          if ("state" in answer) return void handle(answer);
          jobId = answer.id;
          history.replaceState(null, "", `#read=${jobId}`);
        }
        const next = await readProgress(jobId);
        if (!alive || handle(next)) return;
      } catch (e) {
        if (alive) return onFail((e as Error).message);
      }
      if (alive) setTimeout(tick, 900);
    };
    void tick();
    return () => {
      alive = false;
      clearInterval(clock);
    };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const waiting = !p; // uploading, or (on Vercel) the AI is reading in one go
  const progress = p ? p.progress : 0.9 * (1 - Math.exp(-elapsed / 25));
  const phaseIndex = p ? Math.max(0, PHASES.findIndex((ph) => ph.key.includes(p.phase))) : elapsed > 4 ? 3 : 0;
  const pct = Math.round(progress * 100);

  return (
    <main className="reading">
      <header className="screen-head">
        <BackButton onClick={onCancel} label="Cancel" />
        <h1>Reading {name ? `“${name}”` : "your music"}</h1>
      </header>
      <section className="tile g-sage reading-card">
        <span className="tile-label">{PHASES[phaseIndex].label}</span>
        <Dial size={Math.min(300, window.innerWidth - 80)} ticks={84} progress={progress}>
          <span className="knob knob-photo">{preview ? <img src={preview} alt="" /> : <DocIcon />}</span>
        </Dial>
        <div className="reading-pct" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <span className="dots dots-l">{pct}</span>
          <span className="tile-unit">%</span>
        </div>
        <ol className="phase-dots" aria-label="Steps">
          {PHASES.map((ph, i) => (
            <li key={ph.label} className={i < phaseIndex ? "done" : i === phaseIndex ? "now" : ""} title={ph.label} />
          ))}
        </ol>
      </section>
      <p className="hint">
        {p?.state === "queued" && p.queuePosition > 0
          ? "Waiting for another reading to finish…"
          : p
            ? `${p.seconds}s · ${p.pages > 1 ? `${p.pages} pages · ` : ""}bigger pages take a minute or two`
            : waiting && elapsed > 4
              ? `${Math.round(elapsed)}s · the AI is reading the whole page`
              : "Uploading…"}
      </p>
    </main>
  );
}

function finish(p: ReadProgress, name: string, id: string): { xml: string; info: ScoreInfo } {
  const ai: AIAnswer | null = p.ai ?? null;
  const base: ScoreInfo = {
    title: name,
    source: "reader",
    ai: ai ? { provider: ai.provider, model: ai.model, notes: ai.result.notes, confidence: ai.result.confidence } : undefined,
    aiError: p.aiError ?? undefined,
    expressions: ai?.result.expressions ?? [],
    pages: p.layout?.pages.length && p.pageCount ? { jobId: id, layout: p.layout } : undefined,
  };
  if (p.pieces?.length) {
    let xml = p.pieces.length > 1 ? mergeScores(p.pieces) : p.pieces[0];
    if (ai?.mode === "check") {
      const applied = applyCheck(xml, ai.result);
      xml = applied.xml;
      base.fixed = applied.fixed;
      base.addedMarks = applied.addedMarks;
      base.skipped = ai.result.skippedMeasures ?? [];
      if (ai.result.title) base.title = ai.result.title;
    }
    return { xml, info: base };
  }
  if (ai?.mode === "transcribe") {
    return { xml: transcriptionToXml(ai.result), info: { ...base, source: "ai", title: ai.result.title || name } };
  }
  throw new Error("Couldn't find any music on that page.");
}

// ---------- icons ----------

export function NoteIcon() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden>
      <path d="M18 3v12.6a3.4 3.4 0 1 1-1.8-3V7.3l-7 1.6v8.7a3.4 3.4 0 1 1-1.8-3V5.4z" fill="currentColor" />
    </svg>
  );
}
function DocIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4M9 12h6M9 16h6" />
    </svg>
  );
}
