import { useEffect, useMemo, useRef } from "react";
import { pageUrl, type PageLayout } from "./api";
import type { Entry, Timeline } from "./music/timeline";

/** One bar on a page, in that page's pixels. */
interface BarBox {
  index: number;
  /** Bars of the music it stands for (several for a multi-bar rest), 0-based. */
  first: number;
  last: number;
  page: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** The staves' own top and bottom (no padding), to tell which staff a tap was on. */
  staffTop: number;
  staffBottom: number;
  slots: { x: number; beat: number }[];
}

function barsFrom(layout: PageLayout): BarBox[] {
  const bars: BarBox[] = [];
  let offset = 0;
  layout.pages.forEach((p, page) => {
    let previous = 0;
    let highest = 0;
    for (const sys of p.systems) {
      const pad = Math.max(14, (sys.bottom - sys.top) * 0.2);
      for (const m of sys.measures) {
        const id = m.id ?? previous + 1;
        if (id <= previous) continue; // duplicate of a box already placed
        const first = offset + previous;
        const last = offset + Math.max(id, previous + 1) - 1;
        previous = Math.max(id, previous + 1);
        highest = Math.max(highest, previous);
        bars.push({
          index: bars.length,
          first,
          last,
          page,
          left: m.left,
          right: m.right,
          top: sys.top - pad,
          bottom: sys.bottom + pad,
          staffTop: sys.top,
          staffBottom: sys.bottom,
          slots: [...m.slots].sort((a, b) => a.beat - b.beat),
        });
      }
    }
    offset += highest;
  });
  return bars;
}

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
 * Your own pages as the score: the playing bar lights up with a cursor on the beat.
 * Tap a bar to hear it / play from it; hold (or right-click) a note to sing it.
 */
export function PagesView({
  jobId,
  layout,
  timeline,
  active,
  cursor,
  selected,
  playing,
  onTap,
  onSing,
}: {
  jobId: string;
  layout: PageLayout;
  timeline: Timeline;
  active: string[];
  cursor: string | null;
  selected: Set<string>;
  playing: boolean;
  onTap: (id: string) => void;
  onSing: (id: string) => void;
}) {
  const bars = useMemo(() => barsFrom(layout), [layout]);
  const byMeasure = useMemo(() => {
    const map = new Map<number, Entry[]>();
    for (const e of timeline.entries) map.set(e.measureIndex, [...(map.get(e.measureIndex) ?? []), e]);
    return map;
  }, [timeline]);
  const nowRefs = useRef<(SVGRectElement | null)[]>([]);
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

  // What's lit: the playing bar (or the tapped note's bar), and a cursor at the note.
  const focusEntry = timeline.byId.get(active[0] ?? "") ?? (!playing ? timeline.byId.get(cursor ?? "") : undefined);
  const focusBar = barOf(focusEntry);
  const cursorX = focusBar && focusEntry ? xOf(focusBar, focusEntry) : 0;

  // Keep the playing bar in view, unless you've just scrolled yourself.
  useEffect(() => {
    if (!playing || !focusBar) return;
    if (performance.now() - userScrolledAt.current < 4000) return;
    const r = nowRefs.current[focusBar.page]?.getBoundingClientRect();
    const dock = document.querySelector(".dock")?.getBoundingClientRect().top ?? window.innerHeight;
    if (r && r.height > 0 && (r.top < 64 || r.bottom > dock - 12)) {
      window.scrollTo({
        top: Math.max(0, window.scrollY + r.top - Math.min(140, dock * 0.22)),
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
    }
  }, [focusBar, playing]);

  // Tap → nearest note in that bar (on the staff you touched); hold → sing it.
  const pick = (svg: SVGSVGElement, clientX: number, clientY: number, page: number): string | null => {
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    const bar = bars.find((b) => b.page === page && p.x >= b.left - 6 && p.x <= b.right + 6 && p.y >= b.top && p.y <= b.bottom);
    if (!bar) return null;
    const entries: Entry[] = [];
    for (let m = bar.first; m <= bar.last; m++) entries.push(...(byMeasure.get(m) ?? []));
    if (!entries.length) return null;
    const staves = timeline.staves.length;
    const staff = Math.max(0, Math.min(staves - 1, Math.floor(((p.y - bar.staffTop) / Math.max(1, bar.staffBottom - bar.staffTop)) * staves)));
    const own = entries.filter((e) => e.staffIndex === staff);
    const pool = own.length ? own : entries;
    return pool.reduce((a, b) => (Math.abs(xOf(bar, b) - p.x) < Math.abs(xOf(bar, a) - p.x) ? b : a)).id;
  };

  const press = useRef<{ x: number; y: number; timer: number; long: boolean } | null>(null);

  return (
    <div className="pages">
      {layout.pages.map((page, pi) => (
        <div key={pi} className="page" style={{ aspectRatio: `${page.width} / ${page.height}` }}>
          <img src={pageUrl(jobId, pi + 1)} alt={`Page ${pi + 1}`} draggable={false} />
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
                  const id = press.current === d ? pick(svg, clientX, clientY, pi) : null;
                  if (id) {
                    d.long = true;
                    onSing(id);
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
              const id = pick(e.currentTarget, e.clientX, e.clientY, pi);
              if (id) onTap(id);
            }}
            onPointerCancel={() => (press.current = null)}
            onContextMenu={(e) => {
              e.preventDefault();
              const id = pick(e.currentTarget, e.clientX, e.clientY, pi);
              if (id) onSing(id);
            }}
          >
            {[...selected].map((id) => {
              const e = timeline.byId.get(id);
              const bar = barOf(e);
              if (!e || !bar || bar.page !== pi) return null;
              const staves = timeline.staves.length;
              const h = (bar.staffBottom - bar.staffTop) / staves;
              return <circle key={id} className="picked" cx={xOf(bar, e)} cy={bar.staffTop + h * (e.staffIndex + 0.5)} r={Math.max(14, h * 0.32)} />;
            })}
            {focusBar && focusBar.page === pi ? (
              <>
                <rect
                  ref={(el) => {
                    nowRefs.current[pi] = el;
                  }}
                  className={`now ${playing ? "playing" : ""}`}
                  x={focusBar.left}
                  y={focusBar.top}
                  width={focusBar.right - focusBar.left}
                  height={focusBar.bottom - focusBar.top}
                  rx={10}
                />
                <line className="cursor" x1={cursorX} x2={cursorX} y1={focusBar.top} y2={focusBar.bottom} />
              </>
            ) : null}
          </svg>
        </div>
      ))}
      {bars.length && bars[bars.length - 1].last + 1 !== timeline.barQuarters.length ? (
        <p className="pages-note">
          The pages show {bars[bars.length - 1].last + 1} bars and the music has {timeline.barQuarters.length}, so the highlight may drift a little. “Clean score” is exact.
        </p>
      ) : null}
    </div>
  );
}
