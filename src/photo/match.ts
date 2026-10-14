// Links every note the app plays to the notehead it came from on your photo, so playback
// can light up the real note and you can tap notes directly on the page.

import type { PageLayout } from "../api";
import type { Entry, Timeline } from "../music/timeline";

/** One notehead on a page, tied to the note that plays it. */
export interface NoteBox {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  entryId: string;
  midi: number;
}

/** A bar on a page (page pixels) and the bars of the music it stands for. */
export interface BarBox {
  index: number;
  first: number;
  last: number;
  page: number;
  system: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  staffTop: number;
  staffBottom: number;
  slots: { x: number; beat: number }[];
}

/** Bar boxes in reading order. A multi-bar rest is one box standing for several bars. */
export function barsFrom(layout: PageLayout): BarBox[] {
  const bars: BarBox[] = [];
  let offset = 0;
  layout.pages.forEach((p, page) => {
    let previous = 0;
    let highest = 0;
    p.systems.forEach((sys, system) => {
      const pad = Math.max(14, (sys.bottom - sys.top) * 0.2);
      for (const m of sys.measures) {
        const id = m.id ?? previous + 1;
        if (id <= previous) continue; // a duplicate box (cautionary key change etc.)
        const first = offset + previous;
        const last = offset + Math.max(id, previous + 1) - 1;
        previous = Math.max(id, previous + 1);
        highest = Math.max(highest, previous);
        bars.push({
          index: bars.length,
          first,
          last,
          page,
          system,
          left: m.left,
          right: m.right,
          top: sys.top - pad,
          bottom: sys.bottom + pad,
          staffTop: sys.top,
          staffBottom: sys.bottom,
          slots: [...m.slots].sort((a, b) => a.beat - b.beat),
        });
      }
    });
    offset += highest;
  });
  return bars;
}

interface Head {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Matches notes to noteheads bar by bar and staff by staff. When the reader found exactly as
 * many heads as there are notes (the usual case) they pair up in order: left to right, and
 * top to bottom within a chord. Otherwise an alignment by position in the bar decides.
 */
export function matchNotes(timeline: Timeline, layout: PageLayout): Map<string, NoteBox[]> {
  const boxes = new Map<string, NoteBox[]>();
  const bars = barsFrom(layout);
  // Notes by bar.
  const byMeasure = new Map<number, Entry[]>();
  for (const e of timeline.entries) byMeasure.set(e.measureIndex, [...(byMeasure.get(e.measureIndex) ?? []), e]);

  for (const bar of bars) {
    if (bar.last !== bar.first) continue; // multi-bar rest: no notes
    const sys = layout.pages[bar.page].systems[bar.system];
    if (!sys.staves?.length || !sys.heads?.length) continue;
    const entries = byMeasure.get(bar.first) ?? [];
    if (!entries.length) continue;
    const barQuarters = timeline.barQuarters[bar.first] || 4;

    // Each staff of the line, and its place within its part.
    const seenPerPart = new Map<number, number>();
    for (const staff of sys.staves) {
      const inPart = seenPerPart.get(staff.part) ?? 0;
      seenPerPart.set(staff.part, inPart + 1);
      const heads: Head[] = sys.heads
        .filter((h) => h.staff === staff.id && h.x + h.w / 2 >= bar.left && h.x + h.w / 2 < bar.right)
        .sort((a, b) => a.x - b.x || a.y - b.y);
      const notes = entries
        .filter((e) => e.partIndex === staff.part - 1 && e.staffInPart === inPart)
        .flatMap((e) => e.pitches.map((p) => ({ entry: e, midi: p.midi })))
        .sort((a, b) => a.entry.barQuarter - b.entry.barQuarter || b.midi - a.midi);
      if (!heads.length || !notes.length) continue;

      const pairs: [number, number][] = [];
      if (heads.length === notes.length) {
        // Chords: heads at the same x are ordered top-down; notes in a chord high-to-low. Same order.
        const ordered = sortChordsTopDown(heads, Math.max(4, (staff.bottom - staff.top) / 8));
        for (let i = 0; i < notes.length; i++) pairs.push([i, heads.indexOf(ordered[i])]);
      } else {
        // Align by where each note falls in the bar.
        const width = Math.max(1, bar.right - bar.left);
        const nf = notes.map((n) => n.entry.barQuarter / barQuarters);
        const hf = heads.map((h) => (h.x + h.w / 2 - bar.left) / width);
        for (const [i, j] of align(nf, hf)) pairs.push([i, j]);
      }
      for (const [i, j] of pairs) {
        const n = notes[i];
        const h = heads[j];
        if (!n || !h) continue;
        const list = boxes.get(n.entry.id) ?? [];
        list.push({ page: bar.page, x: h.x, y: h.y, w: h.w, h: h.h, entryId: n.entry.id, midi: n.midi });
        boxes.set(n.entry.id, list);
      }
    }
  }
  return boxes;
}

/** Heads ordered left to right, but heads stacked at the same x (a chord) from top to bottom. */
function sortChordsTopDown(heads: Head[], tolerance: number): Head[] {
  const columns: Head[][] = [];
  for (const h of [...heads].sort((a, b) => a.x - b.x)) {
    const col = columns[columns.length - 1];
    if (col && Math.abs(h.x - col[0].x) <= tolerance) col.push(h);
    else columns.push([h]);
  }
  return columns.flatMap((c) => c.sort((a, b) => a.y - b.y));
}

/** Minimal-cost alignment of two increasing sequences (positions 0…1), allowing skips. */
function align(a: number[], b: number[]): [number, number][] {
  const SKIP = 0.18;
  const n = a.length;
  const m = b.length;
  const cost = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const move = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
  for (let i = 1; i <= n; i++) {
    cost[i][0] = i * SKIP;
    move[i][0] = 1;
  }
  for (let j = 1; j <= m; j++) {
    cost[0][j] = j * SKIP;
    move[0][j] = 2;
  }
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++) {
      const match = cost[i - 1][j - 1] + Math.abs(a[i - 1] - b[j - 1]);
      const skipA = cost[i - 1][j] + SKIP;
      const skipB = cost[i][j - 1] + SKIP;
      if (match <= skipA && match <= skipB) {
        cost[i][j] = match;
        move[i][j] = 0;
      } else if (skipA <= skipB) {
        cost[i][j] = skipA;
        move[i][j] = 1;
      } else {
        cost[i][j] = skipB;
        move[i][j] = 2;
      }
    }
  const out: [number, number][] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const mv = move[i][j];
    if (mv === 0) {
      out.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (mv === 1) i--;
    else j--;
  }
  return out.reverse();
}
