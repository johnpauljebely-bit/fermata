import { pitchFromMidi } from "../music/pitch";
import type { Plan, PlanNote } from "./session";

/** One pitch reading from the microphone, in seconds since the warm-up started. */
export interface Sample {
  t: number;
  midi: number | null;
}

export type Verdict = "great" | "good" | "close" | "off" | "silent";

export interface NoteResult {
  /** Index among the sung (non-"listen") notes. */
  index: number;
  note: PlanNote;
  score: number;
  verdict: Verdict;
  /** Median distance from the note in cents (any octave), + = sharp. */
  cents: number | null;
  /** How much the pitch wandered (cents, interquartile). */
  wobble: number;
  /** Seconds before you settled on the note. */
  late: number | null;
  /** −1 = an octave below, +1 = above, 0 = written octave. */
  octave: number;
  voiced: number;
  title: string;
  body: string;
  tip: string | null;
}

export interface Review {
  notes: NoteResult[];
  score: number;
  headline: string;
  tips: string[];
}

// Generous windows: voices naturally move a little, and singing should feel rewarding.
const IN_TUNE = 30;
const CLOSE = 70;

/** Lifts raw accuracy (0…1) onto a kinder curve: 50% raw ≈ 70, 80% raw ≈ 92. */
const curve = (raw: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, raw)), 1.7);

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
};
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))] : 0;
};

/** Scores every sung note and writes kind, specific feedback for each one. */
export function buildReview(plan: Plan, samples: Sample[]): Review {
  // Stopped early? Only judge the notes you reached.
  const end = samples.length ? samples[samples.length - 1].t : 0;
  const sung = plan.notes.filter((n) => !n.cue && n.start + n.duration * 0.5 < end);
  const notes: NoteResult[] = sung.map((note, index) => {
    // Give the first 80 ms to the attack (consonant, scoop), judge the rest.
    const from = note.start + Math.min(0.08, note.duration * 0.2);
    const window = samples.filter((s) => s.t >= note.start && s.t < note.start + note.duration);
    const judged = window.filter((s) => s.t >= from);
    const voicedSamples = judged.filter((s) => s.midi !== null) as { t: number; midi: number }[];
    const voiced = judged.length ? voicedSamples.length / judged.length : 0;
    if (voicedSamples.length < 3 || voiced < 0.2) {
      return {
        index,
        note,
        score: 0,
        verdict: "silent",
        cents: null,
        wobble: 0,
        late: null,
        octave: 0,
        voiced,
        title: `${pitchFromMidi(note.midi).name}: we couldn't hear you`,
        body: "There wasn't enough voice on this note to judge it.",
        tip: "Sing out a little more, and wear headphones so the mic hears you rather than the piano.",
      };
    }
    const octave = Math.round(median(voicedSamples.map((s) => (s.midi - note.midi) / 12)));
    const cents = voicedSamples.map((s) => (s.midi - octave * 12 - note.midi) * 100);
    const med = median(cents);
    const wobble = quantile(cents, 0.75) - quantile(cents, 0.25);
    const inTune = cents.filter((c) => Math.abs(c) <= IN_TUNE).length / cents.length;
    const close = cents.filter((c) => Math.abs(c) <= CLOSE).length / cents.length;
    const firstGood = voicedSamples.find((s) => Math.abs((s.midi - octave * 12 - note.midi) * 100) <= IN_TUNE);
    const late = firstGood ? Math.max(0, firstGood.t - note.start) : null;
    // Effort counts too: any voiced note earns a base, accuracy fills the rest.
    const raw = (inTune * 0.65 + close * 0.35) * Math.min(1, voiced / 0.6);
    const score = Math.round(Math.min(100, 20 + 80 * curve(raw)));
    const verdict: Verdict = score >= 85 ? "great" : score >= 68 ? "good" : score >= 45 ? "close" : "off";
    const name = pitchFromMidi(note.midi).name;
    const dir = med > 0 ? "sharp (a bit high)" : "flat (a bit low)";

    let title: string;
    let body: string;
    let tip: string | null = null;
    if (verdict === "great") {
      title = `${name}: beautiful`;
      body = Math.abs(med) < 8 ? "Right in the centre of the note, and steady." : `In tune, sitting just slightly ${med > 0 ? "high" : "low"} (${Math.abs(Math.round(med))}¢).`;
    } else if (verdict === "good") {
      title = `${name}: really nice`;
      body = `Mostly in tune. You sat about ${Math.abs(Math.round(med))}¢ ${dir} on average, which is a small adjustment.`;
      tip = wobble > 35 ? "Hold the note a touch steadier: keep the air flowing evenly to the end." : med > 0 ? "Aim a hair lower: relax rather than push." : "Aim a hair higher: lift your eyebrows and think of the note above.";
    } else if (verdict === "close") {
      title = `${name}: so close`;
      body = Math.abs(med) > IN_TUNE ? `Nearly there: you were around ${Math.abs(Math.round(med))}¢ ${dir}.` : "You found the right note; the pitch just moved around a bit.";
      tip =
        wobble > 45
          ? "The pitch wobbled. Relax your jaw and keep the breath low and steady."
          : med < 0
            ? "Going flat usually means running out of support: take a fuller breath and keep it bright."
            : "Going sharp usually means pushing: sing it lighter and let the note float.";
    } else {
      title = `${name}: good try`;
      const off = Math.abs(med) >= 100 ? `about ${Math.round(Math.abs(med) / 100)} semitone${Math.abs(med) >= 150 ? "s" : ""} ${med > 0 ? "above" : "below"} it` : `${Math.abs(Math.round(med))}¢ ${dir}`;
      body = `You were ${off}. That's very fixable.`;
      tip = "Hum the note quietly with the piano first, then sing it. Slowing the warm-up down can help too.";
    }
    if (late !== null && late > 0.25 && verdict !== "great") tip = `You got there, it just took ${late.toFixed(1)}s to land. Hear it in your head before you start, then aim straight for the middle.`;
    if (tip) tip = `To make it even better: ${tip.charAt(0).toLowerCase()}${tip.slice(1)}`;
    if (octave !== 0) body += ` (You sang it an octave ${octave < 0 ? "lower" : "higher"}, which still counts.)`;
    return { index, note, score, verdict, cents: med, wobble, late, octave, voiced, title, body, tip };
  });

  const heard = notes.filter((n) => n.verdict !== "silent");
  const score = notes.length ? Math.round(notes.reduce((s, n) => s + n.score, 0) / notes.length) : 0;
  const tips: string[] = [];
  if (heard.length < notes.length * 0.5) tips.push("We couldn't hear quite a few notes. Sing out with confidence, and use headphones so the mic hears you.");
  // Leaning sharp/flat: only from notes you were near (wrong notes would swamp it).
  const near = heard.filter((n) => n.cents !== null && Math.abs(n.cents) < 80);
  const avg = near.length >= 3 ? near.reduce((s, n) => s + (n.cents ?? 0), 0) / near.length : 0;
  if (Math.abs(avg) > 18) tips.push(avg < 0 ? `You tend to sit a little flat (${Math.round(-avg)}¢). Keep your breath support going and think "up".` : `You tend to sit a little sharp (${Math.round(avg)}¢). Sing lighter and don't push.`);
  // Trouble up high or down low?
  const sorted = [...heard].sort((a, b) => a.note.midi - b.note.midi);
  const third = Math.max(1, Math.floor(sorted.length / 3));
  const lowAvg = sorted.slice(0, third).reduce((s, n) => s + n.score, 0) / third;
  const highAvg = sorted.slice(-third).reduce((s, n) => s + n.score, 0) / third;
  if (sorted.length >= 6 && highAvg < lowAvg - 20)
    tips.push(`Your higher notes (around ${pitchFromMidi(sorted[sorted.length - 1].note.midi).name}) were harder. Keep them light and try the octave-down option until they feel easy.`);
  else if (sorted.length >= 6 && lowAvg < highAvg - 20) tips.push(`Your lowest notes were harder. Don't press down for them; let them be quieter.`);
  if (heard.some((n) => n.wobble > 45)) tips.push("Some long notes wobbled. Practise long tones to build a steady stream of air.");
  const late = heard.filter((n) => n.late !== null && n.late > 0.25).length;
  if (late > heard.length * 0.3) tips.push("You often slid into notes. Aim for the centre of each note from the start.");
  if (!tips.length && score >= 80) tips.push("Really solid all the way through. Try the next voice range up, or a faster exercise.");

  const headline =
    score >= 88 ? "Brilliant" : score >= 75 ? "Really nice" : score >= 60 ? "Good work" : heard.length ? "Nice start" : "We couldn't hear you";
  // Start with what went well.
  const best = [...heard].sort((a, b) => b.score - a.score)[0];
  const greats = heard.filter((n) => n.verdict === "great" || n.verdict === "good").length;
  if (greats >= 3) tips.unshift(`${greats} of ${notes.length} notes were spot on or close to it. Nice work!`);
  else if (best && best.score >= 60) tips.unshift(`Your best note was ${pitchFromMidi(best.note.midi).name}, really well placed.`);
  return { notes, score, headline, tips: tips.slice(0, 4) };
}

export const VERDICT_COLOR: Record<Verdict, string> = {
  great: "--good",
  good: "--good",
  close: "--near",
  off: "--danger",
  silent: "--ink-3",
};
