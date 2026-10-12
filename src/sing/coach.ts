/**
 * Listens to someone trying to sing one target note and says what to do:
 * how close they are, up or down, and — when the note keeps cracking or sits out of
 * reach — to try it an octave lower or higher.
 */

export type Verdict =
  | { kind: "silent" }
  | { kind: "on"; cents: number }
  | { kind: "close"; cents: number }
  | { kind: "off"; semitones: number }
  | { kind: "octave"; octaves: number; cents: number };

export interface Advice {
  verdict: Verdict;
  /** Seconds held in tune (any octave counts) during this attempt. */
  heldOn: number;
  /** Set once singing has been shaky: what to try instead. */
  suggest: "octave-down" | "octave-up" | null;
  /** Why the suggestion was made. */
  reason: "cracking" | "out-of-reach" | null;
  /** Number of cracks / breaks noticed recently. */
  cracks: number;
}

const ON_CENTS = 25;
const CLOSE_CENTS = 60;

export class NoteCoach {
  private last: { t: number; midi: number } | null = null;
  private crackTimes: number[] = [];
  private voicedSince: number | null = null;
  private voicedFrames: { t: number; midi: number }[] = [];
  private heldOn = 0;
  /** Moments spent in tune, to judge only the last few seconds. */
  private onTimes: { t: number; dt: number }[] = [];
  private suggest: Advice["suggest"] = null;
  private reason: Advice["reason"] = null;

  constructor(public target: number) {}

  setTarget(target: number) {
    this.target = target;
    this.heldOn = 0;
    this.crackTimes = [];
    this.voicedFrames = [];
    this.onTimes = [];
    this.suggest = null;
    this.reason = null;
  }

  /** `t` in seconds, `midi` fractional or null when silent. */
  push(t: number, midi: number | null): Advice {
    const dt = this.last ? Math.min(0.1, t - this.last.t) : 0;
    if (midi === null) {
      // A sudden drop-out in the middle of a held note is a break too.
      if (this.voicedSince !== null && t - this.voicedSince > 0.35 && this.last && t - this.last.t < 0.08) this.crack(t);
      this.voicedSince = null;
      this.last = this.last && t - this.last.t > 0.25 ? null : this.last;
      return this.advice({ kind: "silent" });
    }
    this.voicedSince ??= t;
    // A big jump between consecutive frames (≥ 4 semitones in < 80 ms) is a crack/flip.
    if (this.last && t - this.last.t < 0.08 && Math.abs(midi - this.last.midi) >= 4) this.crack(t);
    this.last = { t, midi };
    this.voicedFrames.push({ t, midi });
    while (this.voicedFrames.length && t - this.voicedFrames[0].t > 4) this.voicedFrames.shift();

    const diff = midi - this.target;
    const octaves = Math.round(diff / 12);
    const centsInOctave = (diff - octaves * 12) * 100;
    let verdict: Verdict;
    if (Math.abs(diff * 100) <= ON_CENTS) verdict = { kind: "on", cents: diff * 100 };
    else if (Math.abs(diff * 100) <= CLOSE_CENTS) verdict = { kind: "close", cents: diff * 100 };
    else if (octaves !== 0 && Math.abs(centsInOctave) <= CLOSE_CENTS) verdict = { kind: "octave", octaves, cents: centsInOctave };
    else verdict = { kind: "off", semitones: diff };

    if ((verdict.kind === "on" || (verdict.kind === "octave" && Math.abs(centsInOctave) <= ON_CENTS)) && dt) {
      this.heldOn += dt;
      this.onTimes.push({ t, dt });
    }
    while (this.onTimes.length && t - this.onTimes[0].t > 4) this.onTimes.shift();
    const recentOn = this.onTimes.reduce((s, x) => s + x.dt, 0);

    // Shaky: several cracks in 4 s, or 3 s of trying without getting near.
    const recentCracks = this.crackTimes.filter((c) => t - c < 4).length;
    const span = this.voicedFrames.length ? t - this.voicedFrames[0].t : 0;
    const neverClose = span > 3 && this.voicedFrames.every((f) => Math.abs(f.midi - this.target) * 100 > CLOSE_CENTS);
    if ((recentCracks >= 2 || neverClose) && recentOn < 0.8) {
      const avg = this.voicedFrames.reduce((s, f) => s + f.midi, 0) / Math.max(1, this.voicedFrames.length);
      // Straining towards a note above you → go down an octave; struggling to get low enough → go up.
      this.suggest = avg <= this.target ? "octave-down" : "octave-up";
      this.reason = recentCracks >= 2 ? "cracking" : "out-of-reach";
    }
    return this.advice(verdict);
  }

  private crack(t: number) {
    if (!this.crackTimes.length || t - this.crackTimes[this.crackTimes.length - 1] > 0.25) this.crackTimes.push(t);
  }

  private advice(verdict: Verdict): Advice {
    const now = this.last?.t ?? 0;
    return { verdict, heldOn: this.heldOn, suggest: this.suggest, reason: this.reason, cracks: this.crackTimes.filter((c) => now - c < 4).length };
  }
}

/** Words for a verdict. */
export function describe(v: Verdict): { title: string; detail: string; tone: "good" | "near" | "far" | "idle" } {
  switch (v.kind) {
    case "silent":
      return { title: "Sing the note", detail: "Hold it steady on “ah” or “oo”", tone: "idle" };
    case "on":
      return { title: "Spot on", detail: centsWords(v.cents), tone: "good" };
    case "close":
      return { title: v.cents < 0 ? "A touch higher" : "A touch lower", detail: centsWords(v.cents), tone: "near" };
    case "octave":
      return {
        title: Math.abs(v.cents) <= ON_CENTS ? "Right note, other octave" : v.cents < 0 ? "Other octave · a touch higher" : "Other octave · a touch lower",
        detail: `You're ${Math.abs(v.octaves)} octave${Math.abs(v.octaves) > 1 ? "s" : ""} ${v.octaves < 0 ? "below" : "above"} it — that counts`,
        tone: Math.abs(v.cents) <= ON_CENTS ? "good" : "near",
      };
    case "off": {
      const n = Math.abs(v.semitones);
      const steps = n >= 1.5 ? `${Math.round(n)} semitones` : "a semitone";
      return { title: v.semitones < 0 ? "Go higher ↑" : "Go lower ↓", detail: `About ${steps} ${v.semitones < 0 ? "below" : "above"}`, tone: "far" };
    }
  }
}

function centsWords(c: number) {
  const r = Math.round(c);
  if (Math.abs(r) < 4) return "Right in the middle";
  return `${Math.abs(r)}¢ ${r > 0 ? "sharp" : "flat"}`;
}
