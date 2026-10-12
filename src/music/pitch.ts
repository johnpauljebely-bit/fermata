export type Letter = "C" | "D" | "E" | "F" | "G" | "A" | "B";

/** A pitch with both its sound (MIDI) and its written spelling (B♭4 vs A♯4). */
export interface SpelledPitch {
  midi: number;
  letter: Letter;
  /** Semitones: -2 double flat … +2 double sharp. */
  accidental: number;
  octave: number;
  /** "C4", "F♯3", "B♭4" */
  name: string;
  /** Fixed-do solfège: "Do", "Fa♯", "Ti♭" */
  solfege: string;
}

const LETTER_SEMITONES: Record<Letter, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SOLFEGE: Record<Letter, string> = { C: "Do", D: "Re", E: "Mi", F: "Fa", G: "Sol", A: "La", B: "Ti" };
const SHARP_SPELLING: [Letter, number][] = [
  ["C", 0], ["C", 1], ["D", 0], ["D", 1], ["E", 0], ["F", 0],
  ["F", 1], ["G", 0], ["G", 1], ["A", 0], ["A", 1], ["B", 0],
];

export function accidentalSymbol(accidental: number): string {
  return { [-2]: "𝄫", [-1]: "♭", 0: "", 1: "♯", 2: "𝄪" }[accidental] ?? "";
}

export function spellPitch(letter: Letter, accidental: number, midi: number): SpelledPitch {
  // Octave follows the letter, so B♯3 stays in octave 3 even though it sounds as C4.
  const octave = Math.floor((midi - accidental - LETTER_SEMITONES[letter]) / 12) - 1;
  const symbol = accidentalSymbol(accidental);
  return { midi, letter, accidental, octave, name: `${letter}${symbol}${octave}`, solfege: `${SOLFEGE[letter]}${symbol}` };
}

/** Spelling for a bare MIDI number (e.g. a piano key), preferring sharps. */
export function pitchFromMidi(midi: number): SpelledPitch {
  const [letter, accidental] = SHARP_SPELLING[((midi % 12) + 12) % 12];
  return spellPitch(letter, accidental, midi);
}

/** Letter from a semitone offset within the octave (OSMD's NoteEnum uses these values). */
export function letterFromSemitone(semitone: number): Letter | undefined {
  return (Object.keys(LETTER_SEMITONES) as Letter[]).find((l) => LETTER_SEMITONES[l] === semitone);
}

export function midiFromFrequency(hz: number): number {
  return Math.round(69 + 12 * Math.log2(hz / 440));
}

/** Note name Tone.js understands ("C#4"). */
export function toneNoteName(midi: number): string {
  const { letter, accidental, octave } = pitchFromMidi(midi);
  return `${letter}${accidental ? "#" : ""}${octave}`;
}

export function isBlackKey(midi: number): boolean {
  return [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);
}
