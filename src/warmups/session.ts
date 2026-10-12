import * as Tone from "tone";
import { getPiano, unlockAudio } from "../audio/piano";
import { stop as stopPlayer } from "../audio/player";
import { toneNoteName } from "../music/pitch";
import { degreeSemitones, patternSpan, type ExerciseDef } from "./library";

export const RANGES = [
  { id: "low", label: "Low voice", low: 43, high: 64 },
  { id: "mid", label: "Middle voice", low: 48, high: 72 },
  { id: "high", label: "High voice", low: 57, high: 81 },
] as const;
export type RangeId = (typeof RANGES)[number]["id"];

/** Tonics a semitone apart, up then back down, inside the range. */
export function planKeys(ex: ExerciseDef, rangeId: RangeId, steps = 5): number[] {
  const r = RANGES.find((x) => x.id === rangeId) ?? RANGES[1];
  const first = r.low + 2;
  const last = r.high - 2 - patternSpan(ex);
  const up: number[] = [];
  for (let t = first; t <= Math.max(first, last) && up.length < steps; t++) up.push(t);
  return up.length > 1 ? [...up, ...up.slice(0, -1).reverse()] : up;
}

/** One note on the lane: `cue` notes are the piano's "here's your note" (listen, don't sing). */
export interface PlanNote {
  start: number;
  duration: number;
  midi: number;
  cue: boolean;
  rep: number;
}

export interface Plan {
  notes: PlanNote[];
  chords: { start: number; duration: number; midis: number[]; velocity: number }[];
  end: number;
  reps: number;
}

const lowChord = (tonic: number) => {
  let bass = tonic;
  while (bass > 50) bass -= 12;
  return [bass, bass + 7, bass + 12, bass + 16];
};

/**
 * For each key: the chord with the first note on top (listen), then the pattern to sing
 * over a soft held chord. Times in seconds from the start.
 */
export function buildPlan(ex: ExerciseDef, tonics: number[]): Plan {
  const beat = 60 / ex.bpm;
  const notes: PlanNote[] = [];
  const chords: Plan["chords"] = [];
  let at = 0.2;
  tonics.forEach((tonic, rep) => {
    chords.push({ start: at, duration: beat * 3.5, midis: lowChord(tonic), velocity: 0.6 });
    notes.push({ start: at + beat * 2, duration: beat * 1.8, midi: tonic, cue: true, rep: rep + 1 });
    at += beat * 4;
    const total = ex.pattern.reduce((s, n) => s + n.beats, 0) * beat;
    chords.push({ start: at, duration: total, midis: lowChord(tonic), velocity: 0.42 });
    for (const n of ex.pattern) {
      const len = n.beats * beat;
      notes.push({ start: at, duration: len * 0.94, midi: tonic + degreeSemitones(n.degree), cue: false, rep: rep + 1 });
      at += len;
    }
    at += beat * 0.5;
  });
  return { notes, chords, end: at + 0.4, reps: tonics.length };
}

/** Seconds since the warm-up started (Transport runs at 60 bpm: 1 beat = 1 s), or null. */
export function warmupTime(): number | null {
  const t = Tone.getTransport();
  return t.state === "started" ? t.seconds : null;
}

/** Plays a plan on the piano (it doubles the voice softly). */
export async function runWarmup(plan: Plan, onEnd: () => void) {
  stopPlayer();
  const unlocking = unlockAudio();
  const piano = await getPiano();
  await unlocking;
  const t = Tone.getTransport();
  t.bpm.value = 60;
  const at = (s: number) => `${Math.round(s * t.PPQ)}i`;
  for (const c of plan.chords) t.schedule((time) => c.midis.forEach((m) => piano.triggerAttackRelease(toneNoteName(m), c.duration, time, c.velocity)), at(c.start));
  for (const n of plan.notes) t.schedule((time) => piano.triggerAttackRelease(toneNoteName(n.midi), n.duration, time, n.cue ? 0.8 : 0.66), at(n.start));
  t.schedule((time) => Tone.getDraw().schedule(() => onEnd(), time), at(plan.end));
  t.position = 0;
  t.start("+0.05");
}
