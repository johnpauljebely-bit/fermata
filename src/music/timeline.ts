import { ArticulationEnum, type MusicSheet, type Note } from "opensheetmusicdisplay";
import type { Expression } from "../api";
import { letterFromSemitone, midiFromFrequency, spellPitch, type SpelledPitch } from "./pitch";
import type { Mark } from "./xml";

/** One note or chord you can tap, hear and see light up. */
export interface Entry {
  id: string;
  index: number;
  measureIndex: number;
  staffIndex: number;
  partIndex: number;
  /** Which staff of its part (0 = top; piano left hand = 1). */
  staffInPart: number;
  /** Seconds from the start at 1× (after fermatas and rit./accel.). */
  start: number;
  duration: number;
  /** How long each key is held (0 = continues a tie, don't strike again). */
  pitches: (SpelledPitch & { hold: number })[];
  /** Quarter notes from the start of its bar (as written). */
  barQuarter: number;
  /** 0…1, from dynamics, hairpins and accents. */
  velocity: number;
  /** Things the playback did with this note, shown when you tap it. */
  marks: string[];
  sourceNotes: Note[];
}

export interface Staff {
  index: number;
  label: string;
}

export interface Timeline {
  entries: Entry[];
  /** Length of each bar in quarter notes. */
  barQuarters: number[];
  staves: Staff[];
  byId: Map<string, Entry>;
  duration: number;
  bpm: number;
}

const FALLBACK_BPM = 96;
const LEVEL: Record<string, number> = { ppp: 0.18, pp: 0.28, p: 0.4, mp: 0.52, mf: 0.64, f: 0.77, ff: 0.88, fff: 0.97 };
const DEFAULT_LEVEL = LEVEL.mf;

interface MeasureTime {
  start: number; // seconds, before warping
  quarter: number; // seconds per quarter
  beatQuarters: number;
}

/**
 * Flattens the score into timed, velocity-shaped entries.
 * `marks` are the dynamics/hairpins written in the score; `expressions` are the AI's extras
 * (articulations it saw, rit./accel.).
 */
export function buildTimeline(sheet: MusicSheet, marks: Mark[], expressions: Expression[]): Timeline {
  const measures = sheet.SourceMeasures;
  let bpm = sheet.DefaultStartTempoInBpm > 0 ? sheet.DefaultStartTempoInBpm : FALLBACK_BPM;
  const startBpm = measures[0]?.TempoInBPM > 0 ? measures[0].TempoInBPM : bpm;
  let seconds = 0;
  const times: MeasureTime[] = measures.map((measure, i) => {
    if (measure.TempoInBPM > 0) bpm = measure.TempoInBPM;
    const next = measures[i + 1];
    const wholes = next ? next.AbsoluteTimestamp.RealValue - measure.AbsoluteTimestamp.RealValue : measure.Duration.RealValue;
    const t = { start: seconds, quarter: 60 / bpm, beatQuarters: measure.ActiveTimeSignature?.Denominator ? 4 / measure.ActiveTimeSignature.Denominator : 1 };
    seconds += wholes * 4 * t.quarter;
    return t;
  });
  const end = seconds;
  const timeAt = (measure: number, quarters: number) => {
    const m = times[Math.max(0, Math.min(times.length - 1, measure))];
    return m ? m.start + quarters * m.quarter : 0;
  };
  const timeAtBeat = (measure1: number, beat1 = 1) => {
    const m = times[Math.max(0, Math.min(times.length - 1, measure1 - 1))];
    return m ? timeAt(measure1 - 1, (Math.max(1, beat1) - 1) * m.beatQuarters) : 0;
  };

  const staffPart = sheet.Staves.map((s) => Math.max(0, sheet.Instruments.indexOf(s.ParentInstrument)));
  const staffInPart = sheet.Staves.map((s) => Math.max(0, s.ParentInstrument?.Staves.indexOf(s) ?? 0));
  const loudness = dynamicsCurves(marks, timeAt, end);
  const partWithMarks = loudness.findIndex((c) => c.segments.length > 0);

  // AI articulations by (part, time).
  const aiArtic = expressions
    .filter((e) => e.type === "articulation" && e.value)
    .map((e) => ({ part: e.part ? e.part - 1 : -1, time: timeAtBeat(e.measure, e.beat), value: e.value! }));

  const entries: Entry[] = [];
  measures.forEach((measure, measureIndex) => {
    const mt = times[measureIndex];
    for (const container of measure.VerticalSourceStaffEntryContainers) {
      const local = container.Timestamp.RealValue * 4;
      const start = mt.start + local * mt.quarter;
      container.StaffEntries.forEach((staffEntry, staffIndex) => {
        if (!staffEntry) return;
        for (const voiceEntry of staffEntry.VoiceEntries) {
          if (voiceEntry.IsGrace) continue;
          const notes = voiceEntry.Notes.filter((n) => !n.isRest() && n.Pitch);
          if (!notes.length) continue;
          const partIndex = staffPart[staffIndex] ?? 0;
          const lengthQ = Math.max(...notes.map((n) => n.Length.RealValue * 4));
          const marksHere: string[] = [];
          const artic = new Set<string>();
          for (const a of voiceEntry.Articulations ?? []) {
            const name = articulationName(a.articulationEnum);
            if (name) artic.add(name);
          }
          for (const a of aiArtic) if (Math.abs(a.time - start) < 0.02 && (a.part < 0 || a.part === partIndex)) artic.add(a.value);

          const curve = loudness[partIndex]?.segments.length ? loudness[partIndex] : loudness[partWithMarks] ?? null;
          let velocity = curve ? curve.at(start) : DEFAULT_LEVEL;
          if (artic.has("accent")) velocity += 0.14;
          if (artic.has("marcato")) velocity += 0.2;
          velocity = Math.max(0.08, Math.min(1, velocity));

          let holdScale = 0.96; // a hair of separation between notes, like a real pianist
          if (artic.has("staccato")) holdScale = 0.45;
          if (artic.has("staccatissimo")) holdScale = 0.3;
          if (artic.has("tenuto")) holdScale = 1;
          artic.forEach((a) => marksHere.push(a));

          entries.push({
            id: "",
            index: 0,
            measureIndex,
            staffIndex,
            partIndex,
            staffInPart: staffInPart[staffIndex] ?? 0,
            start,
            barQuarter: local,
            duration: lengthQ * mt.quarter,
            pitches: notes.map((n) => ({ ...spelled(n), hold: holdOf(n, times) * (holdOf(n, times) > 0 ? holdScale : 0) })),
            velocity,
            marks: marksHere,
            sourceNotes: notes,
          });
        }
      });
    }
  });

  entries.sort((a, b) => a.start - b.start || a.staffIndex - b.staffIndex);

  // Time warps: fermatas hold, rit./accel. bend the tempo.
  const warp = buildWarp(entries, expressions, timeAtBeat);
  for (const e of entries) {
    const s = warp(e.start);
    const f = warp(e.start + e.duration);
    const stretch = e.duration > 0 ? (f - s) / e.duration : 1;
    const fermata = e.marks.includes("fermata") ? FERMATA : 1;
    e.start = s;
    e.duration = f - s;
    for (const p of e.pitches) p.hold *= stretch * fermata;
  }
  entries.forEach((e, i) => {
    e.index = i;
    e.id = `n${i}`;
  });

  return {
    entries,
    barQuarters: measures.map((m, i) => {
      const next = measures[i + 1];
      return (next ? next.AbsoluteTimestamp.RealValue - m.AbsoluteTimestamp.RealValue : m.Duration.RealValue) * 4;
    }),
    staves: staffLabels(sheet),
    byId: new Map(entries.map((e) => [e.id, e])),
    duration: warp(end),
    bpm: startBpm,
  };
}

const FERMATA = 1.8;

function articulationName(a: ArticulationEnum): string | null {
  switch (a) {
    case ArticulationEnum.staccato:
      return "staccato";
    case ArticulationEnum.staccatissimo:
      return "staccatissimo";
    case ArticulationEnum.tenuto:
      return "tenuto";
    case ArticulationEnum.accent:
      return "accent";
    case ArticulationEnum.strongaccent:
    case ArticulationEnum.marcatoup:
    case ArticulationEnum.marcatodown:
      return "marcato";
    case ArticulationEnum.fermata:
    case ArticulationEnum.invertedfermata:
      return "fermata";
    default:
      return null;
  }
}

function spelled(n: Note): SpelledPitch {
  const midi = midiFromFrequency(n.Pitch.Frequency);
  return spellPitch(letterFromSemitone(n.Pitch.FundamentalNote) ?? "C", Math.round(n.Pitch.AccidentalHalfTones), midi);
}

/** Seconds the key is held: the whole tie for its first note, 0 for the rest of a tie. */
function holdOf(n: Note, times: MeasureTime[]): number {
  const secs = (x: Note) => {
    const i = x.SourceMeasure.measureListIndex;
    return x.Length.RealValue * 4 * (times[i]?.quarter ?? 60 / FALLBACK_BPM);
  };
  const tie = n.NoteTie;
  if (tie && tie.Notes.length > 1) return tie.StartNote === n ? tie.Notes.reduce((s, x) => s + secs(x), 0) : 0;
  return secs(n);
}

interface Curve {
  segments: { t0: number; t1: number; v0: number; v1: number }[];
  at(time: number): number;
}

/**
 * A loudness curve per part: holds each dynamic until the next, ramps through hairpins.
 * A hairpin ramps to the dynamic written at its end, or by about two levels if there is none.
 */
function dynamicsCurves(marks: Mark[], timeAt: (m: number, q: number) => number, end: number): Curve[] {
  const parts = Math.max(0, ...marks.map((m) => m.part + 1));
  const curves: Curve[] = [];
  for (let p = 0; p < parts; p++) {
    const mine = marks
      .filter((m) => m.part === p)
      .map((m) => ({ ...m, time: timeAt(m.measure, m.at) }))
      .sort((a, b) => a.time - b.time);
    const segments: Curve["segments"] = [];
    let level = DEFAULT_LEVEL;
    const hold = (t: number, v: number) => segments.push({ t0: t, t1: t, v0: v, v1: v });
    for (let i = 0; i < mine.length; i++) {
      const m = mine[i];
      if (m.kind === "dynamic") {
        if (m.value === "sfz" || m.value === "fp") {
          // One loud attack, then back (fp: soft afterwards).
          segments.push({ t0: m.time, t1: m.time + 0.15, v0: Math.min(1, level + 0.25), v1: m.value === "fp" ? LEVEL.p : level });
          if (m.value === "fp") level = LEVEL.p;
        } else if (LEVEL[m.value ?? ""] !== undefined) {
          level = LEVEL[m.value!];
          hold(m.time, level);
        }
      } else if (m.kind === "cresc" || m.kind === "dim") {
        const stop = mine.slice(i + 1).find((x) => x.kind === "stop" || x.kind === "cresc" || x.kind === "dim");
        const stopTime = Math.max(m.time + 0.5, stop?.time ?? Math.min(end, m.time + 4));
        const after = mine.find((x) => x.kind === "dynamic" && x.time >= stopTime - 0.05 && x.time <= stopTime + 2.5 && LEVEL[x.value ?? ""] !== undefined);
        let target = after ? LEVEL[after.value!] : level + (m.kind === "cresc" ? 0.22 : -0.22);
        // A crescendo never gets softer (and a diminuendo never louder), whatever was misread.
        target = m.kind === "cresc" ? Math.max(target, level + 0.08) : Math.min(target, level - 0.08);
        target = Math.max(0.12, Math.min(1, target));
        segments.push({ t0: m.time, t1: stopTime, v0: level, v1: target });
        level = target;
        // Dynamics inside the hairpin are skipped (usually misreads); carry on after it.
        while (i + 1 < mine.length && mine[i + 1].time < stopTime - 0.05) i++;
      }
    }
    segments.sort((a, b) => a.t0 - b.t0);
    curves.push({
      segments,
      at(time) {
        let current: Curve["segments"][number] | null = null;
        for (const sg of segments) if (sg.t0 <= time + 1e-6) current = sg;
        if (!current) return DEFAULT_LEVEL;
        if (time >= current.t1 || current.t1 <= current.t0) return current.v1;
        return current.v0 + ((time - current.t0) / (current.t1 - current.t0)) * (current.v1 - current.v0);
      },
    });
  }
  return curves;
}

/** Maps unwarped seconds → played seconds (fermata pauses, ritardando/accelerando). */
function buildWarp(entries: Entry[], expressions: Expression[], timeAtBeat: (m: number, b?: number) => number) {
  // Fermata: everything after the held chord starts later by the extra hold.
  const pauses = new Map<number, number>();
  for (const e of entries) {
    if (!e.marks.includes("fermata")) continue;
    const endT = +(e.start + e.duration).toFixed(4);
    pauses.set(endT, Math.max(pauses.get(endT) ?? 0, e.duration * (FERMATA - 1)));
  }
  // rit./accel.: tempo slides linearly to ×0.7 (rit.) or ×1.25 (accel.) of itself.
  const ramps = expressions
    .filter((x) => (x.type === "ritardando" || x.type === "accelerando") && x.measure)
    .map((x) => {
      const s = timeAtBeat(x.measure, x.beat);
      const e = x.endMeasure ? timeAtBeat(x.endMeasure, x.endBeat ?? 99) : s + 4;
      return { s, e: Math.max(e, s + 0.5), f1: x.type === "ritardando" ? 0.7 : 1.25 };
    });

  return (t: number) => {
    let out = t;
    for (const [at, extra] of pauses) if (t >= at - 1e-4) out += extra;
    for (const r of ramps) {
      const upTo = Math.min(t, r.e);
      if (upTo <= r.s) continue;
      // ∫ (1/f(x) − 1) dx, f going 1 → f1 across [s, e]
      const steps = 24;
      const h = (upTo - r.s) / steps;
      for (let i = 0; i < steps; i++) {
        const x = r.s + (i + 0.5) * h;
        const f = 1 + (r.f1 - 1) * ((x - r.s) / (r.e - r.s));
        out += h * (1 / f - 1);
      }
    }
    return out;
  };
}

function staffLabels(sheet: MusicSheet): Staff[] {
  const labels = sheet.Staves.map((staff, index) => {
    const inst = staff.ParentInstrument;
    const name = inst?.Name?.trim() || `Part ${sheet.Instruments.indexOf(inst) + 1}`;
    const siblings = inst?.Staves ?? [];
    const pos = siblings.indexOf(staff);
    return { index, label: siblings.length > 1 ? `${name} ${pos === 0 ? "RH" : pos === 1 ? "LH" : pos + 1}` : name };
  });
  const counts = new Map<string, number>();
  labels.forEach((l) => counts.set(l.label, (counts.get(l.label) ?? 0) + 1));
  const seen = new Map<string, number>();
  for (const l of labels) {
    if ((counts.get(l.label) ?? 0) < 2) continue;
    const n = (seen.get(l.label) ?? 0) + 1;
    seen.set(l.label, n);
    l.label = `${l.label} ${n}`;
  }
  return labels;
}
