import { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Expression, PageLayout } from "./api";
import { PagesView } from "./PagesView";
import { play, playMidi, setRate, stop, strike } from "./audio/player";
import { buildTimeline, type Entry, type Timeline } from "./music/timeline";
import { readMarks } from "./music/xml";
import { SingSheet } from "./sing/SingSheet";
import { BackButton, PillButton } from "./ui";

export interface ScoreInfo {
  title: string;
  source: "sample" | "reader" | "ai";
  ai?: { provider: string; model: string; notes?: string; confidence?: string };
  aiError?: string;
  expressions?: Expression[];
  fixed?: { measure: number; from: string; to: string; reason?: string }[];
  addedMarks?: number;
  skipped?: { afterMeasure: number; count: number; where?: string }[];
  /** Your own pages (from the reader), shown as the score by default. */
  pages?: { jobId?: string; images?: string[]; layout: PageLayout };
}

type WithSvg = { getSVGGElement?: () => SVGGElement | undefined };

export function ScoreScreen({ xml, info, onBack }: { xml: string; info: ScoreInfo; onBack: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const osmd = useRef<OpenSheetMusicDisplay | null>(null);
  const elements = useRef(new Map<string, SVGGElement>());
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState<string | null>(null);
  const [muted, setMuted] = useState<Set<number>>(new Set());
  const [rate, setRateState] = useState(1);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [tapped, setTapped] = useState<Entry | null>(null);
  const [sing, setSing] = useState<{ midi: number; label: string } | null>(null);
  const active = useRef<string[]>([]);
  const [activeIds, setActiveIds] = useState<string[]>([]);
  // Photos are their own score; only the sample uses the engraved view.
  const view: "pages" | "score" = info.pages ? "pages" : "score";
  const viewRef = useRef(view);
  viewRef.current = view;
  const title = useRef(info.title);

  // Load + render.
  useEffect(() => {
    const el = host.current!;
    const o = new OpenSheetMusicDisplay(el, {
      backend: "svg",
      autoResize: false,
      drawTitle: false,
      drawSubtitle: false,
      drawComposer: false,
      drawLyricist: false,
      drawCredits: false,
      drawPartNames: false,
      disableCursor: true,
      defaultColorMusic: "#000000",
      pageFormat: "Endless",
    });
    osmd.current = o;
    let cancelled = false;
    (async () => {
      try {
        await o.load(xml, info.title);
        if (cancelled) return;
        render();
        title.current = o.Sheet.TitleString?.trim() || info.title || "Your music";
        const tl = buildTimeline(o.Sheet, readMarks(xml), info.expressions ?? []);
        if (!tl.entries.length) throw new Error("No playable notes found.");
        setTimeline(tl);
      } catch (e) {
        if (!cancelled) setError((e as Error).message || "This score couldn't be displayed.");
      }
    })();
    return () => {
      cancelled = true;
      stop();
      o.clear();
    };
  }, [xml]); // eslint-disable-line react-hooks/exhaustive-deps

  const render = () => {
    const o = osmd.current;
    const el = host.current;
    if (!o || !el) return;
    const w = el.clientWidth;
    o.zoom = w < 420 ? 0.62 : w < 700 ? 0.75 : 0.95;
    o.render();
  };

  // Map entries → SVG after each render.
  const mapElements = (tl: Timeline) => {
    const o = osmd.current!;
    const map = new Map<string, SVGGElement>();
    for (const e of tl.entries) {
      for (const n of e.sourceNotes) {
        const g = (o.EngravingRules.GNote(n) as unknown as WithSvg | undefined)?.getSVGGElement?.();
        if (g) {
          g.classList.add("is-note");
          map.set(e.id, g);
          break;
        }
      }
    }
    elements.current = map;
  };

  useEffect(() => {
    if (!timeline) return;
    mapElements(timeline);
    let last = host.current?.clientWidth ?? 0;
    let t: number | undefined;
    const onResize = () => {
      clearTimeout(t);
      t = window.setTimeout(() => {
        const w = host.current?.clientWidth ?? 0;
        if (Math.abs(w - last) < 8) return;
        last = w;
        render();
        mapElements(timeline);
        paint();
      }, 200);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [timeline]); // eslint-disable-line react-hooks/exhaustive-deps

  // Classes on the SVG notes.
  const paint = () => {
    for (const [id, g] of elements.current) {
      g.classList.toggle("is-selected", selected.has(id));
      g.classList.toggle("is-cursor", id === cursor && !selectMode && !playing);
      g.classList.toggle("is-active", active.current.includes(id));
      const entry = timeline?.byId.get(id);
      g.classList.toggle("is-muted", !!entry && muted.has(entry.staffIndex));
    }
  };
  useEffect(paint);

  const setActive = (ids: string[]) => {
    for (const id of active.current) elements.current.get(id)?.classList.remove("is-active");
    active.current = ids;
    for (const id of ids) elements.current.get(id)?.classList.add("is-active");
    setActiveIds(ids);
    if (ids.length && viewRef.current === "score") follow(ids[0]);
  };

  const follow = (id: string) => {
    const g = elements.current.get(id);
    if (!g) return;
    const r = g.getBoundingClientRect();
    const dock = document.querySelector(".dock")?.getBoundingClientRect().top ?? window.innerHeight;
    if (r.top > 80 && r.bottom < dock - 40) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: window.scrollY + r.top - dock * 0.3, behavior: reduce ? "auto" : "smooth" });
  };

  // Taps: find the nearest note (noteheads are tiny on a phone).
  const nearestAt = (x: number, y: number, touch: boolean): string | null => {
    let best: string | null = null;
    let bestD = touch ? 30 : 18;
    for (const [id, g] of elements.current) {
      const r = g.getBoundingClientRect();
      const dist = Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
      if (dist < bestD) {
        bestD = dist;
        best = id;
      }
    }
    return best;
  };

  // Press and hold (phone) or right-click (computer): sing that note.
  const openSing = (id: string, midi?: number) => {
    const entry = timeline?.byId.get(id);
    if (!entry) return;
    if (playing) {
      stop();
      setActive([]);
      setPlaying(false);
    }
    setTapped(null);
    setCursor(id);
    navigator.vibrate?.(15);
    const top = entry.pitches.reduce((a, b) => (b.midi > a.midi ? b : a));
    setSing({ midi: midi ?? top.midi, label: `Bar ${entry.measureIndex + 1} · ${timeline!.staves[entry.staffIndex]?.label ?? ""}` });
  };

  const down = useRef<{ x: number; y: number; timer: number; long: boolean } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 2) return;
    const x = e.clientX;
    const y = e.clientY;
    const touch = e.pointerType === "touch";
    const d = { x, y, long: false, timer: 0 };
    if (touch) {
      d.timer = window.setTimeout(() => {
        const id = nearestAt(x, y, true);
        if (id && down.current === d) {
          d.long = true;
          openSing(id);
        }
      }, 450);
    }
    down.current = d;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = down.current;
    if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10) {
      clearTimeout(d.timer);
      down.current = null;
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = down.current;
    down.current = null;
    if (!d) return;
    clearTimeout(d.timer);
    if (d.long || !timeline || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10) return;
    const best = nearestAt(e.clientX, e.clientY, e.pointerType === "touch");
    if (!best) return;
    const entry = timeline.byId.get(best)!;
    void strike(entry, 1);
    navigator.vibrate?.(8);
    if (selectMode) {
      setSelected((s) => {
        const n = new Set(s);
        if (n.has(best)) n.delete(best);
        else n.add(best);
        return n;
      });
    } else {
      setCursor(best);
      setTapped(entry);
    }
  };
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const id = nearestAt(e.clientX, e.clientY, false);
    if (id) openSing(id);
  };

  const audible = useMemo(() => timeline?.entries.filter((e) => !muted.has(e.staffIndex)) ?? [], [timeline, muted]);

  const togglePlay = () => {
    if (!timeline) return;
    if (playing) {
      stop();
      setActive([]);
      setPlaying(false);
      return;
    }
    setTapped(null);
    let list = audible;
    let from = 0;
    if (selectMode && selected.size) {
      list = timeline.entries.filter((e) => selected.has(e.id));
      from = list[0]?.start ?? 0;
    } else if (cursor) from = timeline.byId.get(cursor)?.start ?? 0;
    setPlaying(true);
    void play(list, from, rate, {
      onActive: setActive,
      onEnd: () => setPlaying(false),
    });
  };

  const changeRate = (r: number) => {
    setRateState(r);
    setRate(r);
  };

  const bpm = timeline ? Math.round(timeline.bpm * rate) : null;
  const aiBadge = info.ai ? `${info.ai.provider} checked` : info.source === "sample" ? null : info.aiError ? "AI unavailable" : null;

  return (
    <div className="score-screen">
      <header className="top">
        <BackButton onClick={onBack} label="New music" />
        <h1 title={title.current}>{timeline ? title.current || "Untitled" : info.title}</h1>
        {aiBadge ? (
          <button className="pill" onClick={() => setSheetOpen(true)}>
            {aiBadge}
          </button>
        ) : (
          <span className="top-spacer" />
        )}
      </header>

      {error ? (
        <div className="score-error">
          <p>{error}</p>
          <button className="big" onClick={onBack}>
            Try another photo
          </button>
        </div>
      ) : null}
      {!timeline && !error ? <div className="score-loading">Laying out the music…</div> : null}


      {view === "pages" && info.pages && timeline ? (
        <PagesView
          jobId={info.pages.jobId}
          images={info.pages.images}
          layout={info.pages.layout}
          timeline={timeline}
          active={activeIds}
          cursor={cursor}
          playing={playing}
          selected={selected}
          muted={muted}
          onTap={(id, midi) => {
            const entry = timeline.byId.get(id)!;
            // Tapped a notehead: hear just that note (not the whole chord).
            if (midi !== undefined) void playMidi([midi], 1.2, 0, Math.max(0.5, entry.velocity));
            else void strike(entry, 1);
            navigator.vibrate?.(8);
            if (selectMode) {
              setSelected((s) => {
                const n = new Set(s);
                if (n.has(id)) n.delete(id);
                else n.add(id);
                return n;
              });
              return;
            }
            setCursor(id);
            setTapped(entry);
          }}
          onSing={openSing}
        />
      ) : null}

      <div className={`paper ${selectMode ? "selecting" : ""} ${view === "pages" ? "tucked" : ""}`} aria-hidden={view === "pages"} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => (down.current = null)} onContextMenu={onContextMenu}>
        <div ref={host} className="osmd" />
      </div>

      {tapped && !playing && !selectMode ? (
        <div className="tap-card" role="status">
          <strong className="dots dots-m">{tapped.pitches.map((p) => p.name).join(" ")}</strong>
          <span>
            Bar {tapped.measureIndex + 1}
            {tapped.marks.length ? ` · ${tapped.marks.join(", ")}` : ""} · {loudnessWord(tapped.velocity)}
          </span>
          <div className="tap-actions">
            <button className="link small" onClick={togglePlay}>
              Play from here
            </button>
            <button className="link small" onClick={() => cursor && openSing(cursor)}>
              Sing it
            </button>
          </div>
          <em className="tap-tip">Tip: hold a note (or right-click) to sing it</em>
        </div>
      ) : null}

      {timeline ? (
        <nav className="dock">
          {timeline.staves.length > 1 ? (
            <div className="parts" role="group" aria-label="Parts">
              {timeline.staves.map((s) => (
                <button
                  key={s.index}
                  className={`chip ${muted.has(s.index) ? "" : "on"}`}
                  aria-pressed={!muted.has(s.index)}
                  onClick={() =>
                    setMuted((m) => {
                      const n = new Set(m);
                      if (n.has(s.index)) n.delete(s.index);
                      else if (n.size < timeline.staves.length - 1) n.add(s.index);
                      return n;
                    })
                  }
                >
                  {s.label}
                </button>
              ))}
            </div>
          ) : null}
          <div className="controls">
            <button
              className={`seg ${selectMode ? "on" : ""}`}
              aria-pressed={selectMode}
              onClick={() => {
                setSelectMode((v) => !v);
                setTapped(null);
              }}
            >
              {selectMode ? (selected.size ? `${selected.size} picked` : "Tap notes") : "Pick notes"}
            </button>
            <button className={`play ${playing ? "is-playing" : ""}`} onClick={togglePlay} aria-label={playing ? "Stop" : "Play"} disabled={selectMode && !selected.size}>
              {playing ? (
                <svg viewBox="0 0 24 24" width="26" height="26">
                  <rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="28" height="28">
                  <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.6-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" fill="currentColor" />
                </svg>
              )}
            </button>
            <label className="speed">
              <span className="speed-read">
                <span className="dots dots-s">{bpm}</span> bpm
              </span>
              <input type="range" min={0.4} max={1.6} step={0.05} value={rate} onChange={(e) => changeRate(Number(e.target.value))} aria-label="Speed" />
            </label>
          </div>
          {selectMode && selected.size ? (
            <button className="link small clear" onClick={() => setSelected(new Set())}>
              Clear picks
            </button>
          ) : null}
        </nav>
      ) : null}

      {sing ? <SingSheet midi={sing.midi} label={sing.label} onClose={() => setSing(null)} /> : null}
      {sheetOpen ? <AISheet info={info} onClose={() => setSheetOpen(false)} /> : null}
    </div>
  );
}

function loudnessWord(v: number) {
  return v < 0.24 ? "pp" : v < 0.34 ? "pp" : v < 0.46 ? "p" : v < 0.58 ? "mp" : v < 0.7 ? "mf" : v < 0.82 ? "f" : "ff";
}

function AISheet({ info, onClose }: { info: ScoreInfo; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const exp = info.expressions ?? [];
  const count = (types: string[]) => exp.filter((e) => types.includes(e.type)).length;
  return (
    <dialog ref={ref} className="sheet" onClose={onClose} onClick={(e) => e.target === ref.current && ref.current.close()}>
      <div className="sheet-body">
        <span className="grabber" aria-hidden />
        <h2>{info.ai ? `Checked by ${info.ai.provider}` : "AI check"}</h2>
        {info.ai ? <p className="muted">{info.ai.model}{info.ai.confidence ? ` · ${info.ai.confidence} confidence` : ""}</p> : null}
        {info.aiError ? <p className="error">The AI couldn't help this time: {info.aiError}</p> : null}
        {info.ai?.notes ? <p>{info.ai.notes}</p> : null}
        <ul className="facts">
          {info.source === "ai" ? <li>Transcribed by the AI (the music reader wasn't available).</li> : null}
          {info.fixed?.length ? (
            <li>
              Fixed {info.fixed.length} wrong note{info.fixed.length > 1 ? "s" : ""}:
              <ul>
                {info.fixed.slice(0, 8).map((f, i) => (
                  <li key={i}>
                    Bar {f.measure}: {f.from} → {f.to}
                  </li>
                ))}
              </ul>
            </li>
          ) : info.ai ? (
            <li>No wrong notes found.</li>
          ) : null}
          {count(["dynamic"]) ? <li>{count(["dynamic"])} dynamics (p, f, …) played</li> : null}
          {count(["crescendo", "diminuendo"]) ? <li>{count(["crescendo", "diminuendo"])} crescendos / diminuendos played</li> : null}
          {count(["articulation"]) ? <li>{count(["articulation"])} accents, staccatos or fermatas played</li> : null}
          {count(["ritardando", "accelerando"]) ? <li>{count(["ritardando", "accelerando"])} tempo changes (rit. / accel.)</li> : null}
          {info.skipped?.length ? (
            <li>
              Possibly missed: {info.skipped.map((s) => `${s.count} bar${s.count > 1 ? "s" : ""} after bar ${s.afterMeasure}${s.where ? ` (${s.where})` : ""}`).join("; ")}
            </li>
          ) : null}
        </ul>
        <PillButton onClick={() => ref.current?.close()}>Done</PillButton>
      </div>
    </dialog>
  );
}
