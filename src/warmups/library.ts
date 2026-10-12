/**
 * The exercise library. Each exercise is a short pattern of major-scale degrees, repeated
 * a semitone higher each time. Ids and goal tags are stable: the Phase 4 coach picks
 * exercises from here by id rather than inventing its own.
 */

export type Goal = "warm-up" | "register-breaks" | "breath" | "top-notes" | "agility" | "pitch" | "range";

export const GOALS: { id: Goal; label: string; hint: string }[] = [
  { id: "warm-up", label: "Warm-up", hint: "Gentle starts for a cold voice" },
  { id: "register-breaks", label: "Cracks & breaks", hint: "Smooth the switch between chest and head voice" },
  { id: "breath", label: "Breath", hint: "Support and steady airflow" },
  { id: "top-notes", label: "Top notes", hint: "Strength and ease up high" },
  { id: "agility", label: "Agility", hint: "Quick, clean note changes" },
  { id: "pitch", label: "Pitch", hint: "Landing notes in tune" },
  { id: "range", label: "Range", hint: "Explore further up and down" },
];

/** One note of a pattern: a major-scale degree (1 = tonic, 8 = octave, 9 = ninth) and its length in quarter notes. */
export interface PatternNote {
  degree: number;
  beats: number;
}

export interface ExerciseDef {
  id: string;
  name: string;
  /** What you sing: shown as lyrics under every note. */
  syllable: string;
  summary: string;
  /** How to do it well, in a sentence or two. */
  how: string;
  helps: Goal[];
  /** Fills whole 4/4 bars. */
  pattern: PatternNote[];
  /** Slide between notes (sirens, slides) instead of stepping. */
  glide?: boolean;
  bpm: number;
}

const scale5: PatternNote[] = [1, 2, 3, 4, 5, 4, 3, 2].map((degree) => ({ degree, beats: 0.5 })).concat([{ degree: 1, beats: 4 }]);

export const EXERCISES: ExerciseDef[] = [
  {
    id: "lip-trill-5",
    name: "Lip trills",
    syllable: "brr",
    summary: "A five-note scale on a relaxed lip buzz.",
    how: "Keep the lips loose and the air steady. If the trill stops, press lightly on your cheeks with your fingertips.",
    helps: ["warm-up", "breath", "register-breaks"],
    pattern: scale5,
    bpm: 96,
  },
  {
    id: "siren-oo",
    name: "Sirens",
    syllable: "oo",
    summary: "Slide smoothly up an octave and back, like a siren.",
    how: "Stay light and let the voice flip without forcing. A small wobble at the break is fine; aim for no gaps.",
    helps: ["register-breaks", "range", "warm-up"],
    pattern: [
      { degree: 1, beats: 1 },
      { degree: 5, beats: 1 },
      { degree: 8, beats: 2 },
      { degree: 5, beats: 1 },
      { degree: 1, beats: 3 },
    ],
    glide: true,
    bpm: 80,
  },
  {
    id: "nay-135",
    name: "Bratty “nay”",
    syllable: "nay",
    summary: "1–3–5–3–1 on a bright, forward “nay”.",
    how: "Make it a little nasal and cheeky, like a whiny child. That bright placement carries up through the break.",
    helps: ["register-breaks", "top-notes"],
    pattern: [
      { degree: 1, beats: 1 },
      { degree: 3, beats: 1 },
      { degree: 5, beats: 1 },
      { degree: 3, beats: 1 },
      { degree: 1, beats: 4 },
    ],
    bpm: 100,
  },
  {
    id: "ya-scale-5",
    name: "Five-note scale on “ya”",
    syllable: "ya",
    summary: "Up and down five notes, each one placed cleanly.",
    how: "Let the jaw drop on every “ya” and aim for the centre of each note, not a slide into it.",
    helps: ["pitch", "agility", "warm-up"],
    pattern: scale5,
    bpm: 100,
  },
  {
    id: "octave-slide-ah",
    name: "Octave slides",
    syllable: "ah",
    summary: "Glide up an octave, hold, glide home.",
    how: "Think of the top note as light and high in the head. Don't push up with volume; let the slide carry you.",
    helps: ["range", "top-notes", "register-breaks"],
    pattern: [
      { degree: 1, beats: 2 },
      { degree: 8, beats: 2 },
      { degree: 1, beats: 4 },
    ],
    glide: true,
    bpm: 76,
  },
  {
    id: "arpeggio-mum",
    name: "Arpeggio on “mum”",
    syllable: "mum",
    summary: "1–3–5–8–5–3–1: a big, open arpeggio.",
    how: "Hum into the “m” to feel the buzz in your face, then open to the vowel. Keep the top note the same size as the bottom.",
    helps: ["range", "top-notes", "pitch"],
    pattern: [
      { degree: 1, beats: 1 },
      { degree: 3, beats: 1 },
      { degree: 5, beats: 1 },
      { degree: 8, beats: 1 },
      { degree: 5, beats: 1 },
      { degree: 3, beats: 1 },
      { degree: 1, beats: 2 },
    ],
    bpm: 92,
  },
  {
    id: "long-tones-oo",
    name: "Long tones",
    syllable: "oo",
    summary: "Hold the tonic and the fifth, steady as a laser.",
    how: "Breathe low, then let the air out slowly and evenly. Watch the pitch line stay flat.",
    helps: ["breath", "pitch"],
    pattern: [
      { degree: 1, beats: 4 },
      { degree: 5, beats: 4 },
      { degree: 1, beats: 4 },
    ],
    bpm: 72,
  },
  {
    id: "ya-scale-9",
    name: "Nine-note run on “ya”",
    syllable: "ya",
    summary: "A quick run up to the ninth and back.",
    how: "Keep it light and bouncy, and don't get louder as you go up. Slow the tempo first if notes smear.",
    helps: ["agility", "range"],
    pattern: [1, 2, 3, 4, 5, 6, 7, 8, 9, 8, 7, 6, 5, 4, 3, 2]
      .map((degree) => ({ degree, beats: 0.5 }))
      .concat([{ degree: 1, beats: 4 }]),
    bpm: 84,
  },
];

export const MAJOR = [0, 2, 4, 5, 7, 9, 11];

/** Semitones above the tonic for a scale degree (1-based, can exceed 8). */
export function degreeSemitones(degree: number): number {
  const d = degree - 1;
  return MAJOR[((d % 7) + 7) % 7] + 12 * Math.floor(d / 7);
}

/** Highest semitone above the tonic the pattern reaches. */
export function patternSpan(ex: ExerciseDef): number {
  return Math.max(...ex.pattern.map((n) => degreeSemitones(n.degree)));
}

export function exerciseById(id: string): ExerciseDef | undefined {
  return EXERCISES.find((e) => e.id === id);
}
