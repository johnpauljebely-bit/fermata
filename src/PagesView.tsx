import { useEffect, useMemo, useRef } from "react";
import { pageUrl, type PageLayout } from "./api";
import type { Entry, Timeline } from "./music/timeline";
import { barsFrom, matchNotes, type BarBox, type NoteBox } from "./photo/match";

/** x of a beat inside a bar, between the note positions the reader found. */
function xAtBeat(bar: BarBox, beat: number, barBeats: number): number {
  const pts = [{ x: bar.left + (bar.right - bar.left) * 0.04, beat: 0 }, ...bar.slots, { x: bar.right, beat: barBeats }];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (beat >= a.beat && beat <= b.beat) return a.x + ((b.x - a.x) * (beat - a.beat)) / Math.max(1e-6, b.beat - a.beat);
  }
  return bar.right;
}

/**
 * Your own pages are the score. While playing, the actual noteheads on your photo light up.
 * Tap a note on the page to hear it; hold it (or right-click) to sing it.
 * Where a note couldn't be tied to a notehead, its bar lights up with a cursor on the beat.
 */
export function PagesView({
  jobId,
  images,
  layout,
  timeline,
  active,
  cursor,
  selected,
  muted,
  playing,
  onTap,
  onSing,
}: {
  jobId?: string;
  /** Our own straightened pages (Vercel / phone); otherwise the reader's page images. */
  images?: string[];
  layout: PageLayout;
  timeline: Timeline;
  active: string[];
  cursor: string | null;
  selected: Set<string>;
  muted: Set<number>;
  playing: boolean;
  onTap: (id: string, midi?: number) => void;
  onSing: (id: string, midi?: number) => void;
}) {
  const bars = useMemo(() => barsFrom(layout), [layout]);
  const boxes = useMemo(() => matchNotes(timeline, layout), [timeline, layout]);
  const allBoxes = useMemo(() => [...boxes.values()].flat(), [boxes]);
  // Dev builds: expose the matching for inspection.
  if (import.meta.env.DEV) Object.assign(window, { __fermata: { boxes, timeline, layout, bars } });
  const byMeasure = useMemo(() => {
    const map = new Map<number, Entry[]>();
    for (const e of timeline.entries) map.set(e.measureIndex, [...(map.get(e.measureIndex) ?? []), e]);
    return map;
  }, [timeline]);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const userScrolledAt = useRef(0);

  useEffect(() => {
    const mark = () => (userScrolledAt.current = performance.now());
    window.addEventListener("touchmove", mark, { passive: true });
    window.addEventListener("wheel", mark, { passive: true });
    return () => {
      window.removeEventListener("touchmove", mark);
      window.removeEventListener("wheel", mark);
    };
  }, []);

  const barOf = (entry: Entry | undefined) => (entry ? bars.find((b) => entry.measureIndex >= b.first && entry.measureIndex <= b.last) : undefined);
  const xOf = (bar: BarBox, entry: Entry) =>
    bar.last > bar.first
      ? bar.left + ((bar.right - bar.left) * (entry.measureIndex - bar.first + 0.5)) / (bar.last - bar.first + 1)
      : xAtBeat(bar, entry.barQuarter, timeline.barQuarters[entry.measureIndex] ?? 4);

  // What's lit. Prefer the real noteheads; fall back to the bar + a cursor.
  const activeBoxes = active.flatMap((id) => boxes.get(id) ?? []);
  const cursorBoxes = !playing && cursor ? (boxes.get(cursor) ?? []) : [];
  const focusEntry = timeline.byId.get(active[0] ?? "") ?? (!playing ? timeline.byId.get(cursor ?? "") : undefined);
  const focusBar = barOf(focusEntry);
  const needsCursor = !!focusEntry && !(boxes.get(focusEntry.id)?.length);
  const cursorX = focusBar && focusEntry ? xOf(focusBar, focusEntry) : 0;

  // Keep the playing note in view (unless you've just scrolled yourself).
  const focusKey = activeBoxes[0] ? `${activeBoxes[0].page}:${Math.round(activeBoxes[0].y / 40)}` : focusBar ? `${focusBar.page}:${focusBar.system}` : "";
  useEffect(() => {
    if (!playing || !focusKey) return;
    if (performance.now() - userScrolledAt.current < 4000) return;
    const page = activeBoxes[0]?.page ?? focusBar?.page ?? 0;
    const el = pageRefs.current[page];
    const p = layout.pages[page];
    if (!el || !p) return;
    const r = el.getBoundingClientRect();
    const scale = r.height / p.height;
    const y = activeBoxes[0] ? activeBoxes[0].y : (focusBar?.top ?? 0);
    const yOnScreen = r.top + y * scale;
    const dock = document.querySelector(".dock")?.getBoundingClientRect().top ?? window.innerHeight;
    if (yOnScreen < 90 || yOnScreen > dock - 60) {
      window.scrollTo({
        top: Math.max(0, window.scrollY + yOnScreen - Math.min(200, dock * 0.3)),
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
    }
  }, [focusKey, playing]); // eslint-disable-line react-hooks/exhaustive-deps

  // A tap or hold: the nearest notehead (generous target), else the nearest note in that bar.
  const pick = (svg: SVGSVGElement, clientX: number, clientY: number, page: number): { id: string; midi?: number } | null => {
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    let best: NoteBox | null = null;
    let bestD = Infinity;
    for (const b of allBoxes) {
      if (b.page !== page) continue;
      const d = Math.hypot(p.x - (b.x + b.w / 2), p.y - (b.y + b.h / 2));
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    const reach = best ? Math.max(best.w, best.h) * 1.8 : 0;
    if (best && bestD <= reach) return { id: best.entryId, midi: best.midi };
    const bar = bars.find((b) => b.page === page && p.x >= b.left - 6 && p.x <= b.right + 6 && p.y >= b.top && p.y <= b.bottom);
    if (!bar) return null;
    const entries: Entry[] = [];
    for (let m = bar.first; m <= bar.last; m++) entries.push(...(byMeasure.get(m) ?? []));
    if (!entries.length) return null;
    return { id: entries.reduce((a, b) => (Math.abs(xOf(bar, b) - p.x) < Math.abs(xOf(bar, a) - p.x) ? b : a)).id };
  };

  const press = useRef<{ x: number; y: number; timer: number; long: boolean } | null>(null);
  const mutedEntry = (id: string) => {
    const e = timeline.byId.get(id);
    return !!e && muted.has(e.staffIndex);
  };

  const ellipse = (b: NoteBox, cls: string, key: string) => (
    <ellipse key={key} className={cls} cx={b.x + b.w / 2} cy={b.y + b.h / 2} rx={b.w * 0.85} ry={b.h * 0.85} />
  );
  /** A shape centred on a notehead, `grow` times its size. */
  const glow = (b: NoteBox, cls: string, key: string, fill: string, grow: number) => (
    <ellipse key={key} className={cls} cx={b.x + b.w / 2} cy={b.y + b.h / 2} rx={(b.w / 2) * grow} ry={(b.h / 2) * grow} fill={fill} />
  );

  return (
    <div className="pages">
      {layout.pages.map((page, pi) => (
        <div
          key={pi}
          ref={(el) => {
            pageRefs.current[pi] = el;
          }}
          className="page"
          style={{ aspectRatio: `${page.width} / ${page.height}` }}
        >
          <img src={images?.[pi] ?? pageUrl(jobId ?? "", pi + 1)} alt={`Page ${pi + 1}`} draggable={false} />
          <svg
            viewBox={`0 0 ${page.width} ${page.height}`}
            preserveAspectRatio="none"
            onPointerDown={(e) => {
              if (e.button === 2) return;
              const svg = e.currentTarget;
              const { clientX, clientY } = e;
              const d = { x: clientX, y: clientY, long: false, timer: 0 };
              if (e.pointerType === "touch") {
                d.timer = window.setTimeout(() => {
                  const hit = press.current === d ? pick(svg, clientX, clientY, pi) : null;
                  if (hit) {
                    d.long = true;
                    onSing(hit.id, hit.midi);
                  }
                }, 450);
              }
              press.current = d;
            }}
            onPointerMove={(e) => {
              const d = press.current;
              if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10) {
                clearTimeout(d.timer);
                press.current = null;
              }
            }}
            onPointerUp={(e) => {
              const d = press.current;
              press.current = null;
              if (!d) return;
              clearTimeout(d.timer);
              if (d.long) return;
              const hit = pick(e.currentTarget, e.clientX, e.clientY, pi);
              if (hit) onTap(hit.id, hit.midi);
            }}
            onPointerCancel={() => (press.current = null)}
            onContextMenu={(e) => {
              e.preventDefault();
              const hit = pick(e.currentTarget, e.clientX, e.clientY, pi);
              if (hit) onSing(hit.id, hit.midi);
            }}
          >
            <defs>
              {/* The app's hot pink → violet. */}
              <linearGradient id={`ink-${pi}`} x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#fe196b" />
                <stop offset="100%" stopColor="#8c3af4" />
              </linearGradient>
              <radialGradient id={`halo-${pi}`}>
                <stop offset="0%" stopColor="#ff9fcb" />
                <stop offset="55%" stopColor="#ffd3e6" />
                <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
              </radialGradient>
            </defs>
            {/* Muted parts: their noteheads are dimmed on the page. */}
            {muted.size
              ? allBoxes.filter((b) => b.page === pi && mutedEntry(b.entryId)).map((b, i) => (
                  <rect key={`m${i}`} className="muted-head" x={b.x - b.w * 0.2} y={b.y - b.h * 0.2} width={b.w * 1.4} height={b.h * 1.4} rx={b.h} />
                ))
              : null}
            {[...selected].flatMap((id) => (boxes.get(id) ?? []).filter((b) => b.page === pi).map((b, i) => ellipse(b, "picked", `s${id}${i}`)))}
            {/* The playing note's ink turns pink → violet (screen blend: only the black changes),
                over a soft pink glow (multiply: the ink stays dark under it). */}
            {[...cursorBoxes.map((b) => ({ b, cls: "head-cursor" })), ...activeBoxes.map((b) => ({ b, cls: "head-now" }))]
              .filter(({ b }) => b.page === pi)
              .flatMap(({ b, cls }, i) => [
                glow(b, `${cls} head-halo`, `h${cls}${b.entryId}${i}`, `url(#halo-${pi})`, 3.6),
                glow(b, `${cls} head-ink`, `i${cls}${b.entryId}${i}`, `url(#ink-${pi})`, 1.25),
              ])}
            {needsCursor && focusBar && focusBar.page === pi ? (
              <>
                <rect className={`now ${playing ? "playing" : ""}`} x={focusBar.left} y={focusBar.top} width={focusBar.right - focusBar.left} height={focusBar.bottom - focusBar.top} rx={10} />
                <line className="cursor" x1={cursorX} x2={cursorX} y1={focusBar.top} y2={focusBar.bottom} />
              </>
            ) : null}
          </svg>
        </div>
      ))}
      {bars.length && bars[bars.length - 1].last + 1 !== timeline.barQuarters.length ? (
        <p className="pages-note">
          The pages show {bars[bars.length - 1].last + 1} bars and the music has {timeline.barQuarters.length}, so some highlights may be off.
        </p>
      ) : null}
    </div>
  );
}
