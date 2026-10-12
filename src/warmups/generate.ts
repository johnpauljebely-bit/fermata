import { degreeSemitones, patternSpan, type ExerciseDef } from "./library";

const LETTERS = ["C", "D", "E", "F", "G", "A", "B"];
const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];

/** Major key spelled the usual way for each tonic pitch class: [letter index, alter, fifths]. */
const KEYS: [number, number, number][] = [
  [0, 0, 0], [1, -1, -5], [1, 0, 2], [2, -1, -3], [2, 0, 4], [3, 0, -1],
  [3, 1, 6], [4, 0, 1], [5, -1, -4], [5, 0, 3], [6, -1, -2], [6, 0, 5],
];

interface Spelled {
  step: string;
  alter: number;
  octave: number;
}

/** Spells a scale degree in the major key of `tonicMidi` (so F♯ major's 7th is E♯, not F). */
function spellDegree(tonicMidi: number, degree: number): Spelled {
  const [letterIndex, tonicAlter] = KEYS[((tonicMidi % 12) + 12) % 12];
  const tonicOctave = Math.floor((tonicMidi - tonicAlter - LETTER_PC[letterIndex]) / 12) - 1;
  const steps = letterIndex + degree - 1;
  const letter = ((steps % 7) + 7) % 7;
  const octave = tonicOctave + Math.floor(steps / 7);
  const midi = tonicMidi + degreeSemitones(degree);
  return { step: LETTERS[letter], alter: midi - ((octave + 1) * 12 + LETTER_PC[letter]), octave };
}

export interface KeyPlanOptions {
  /** Your comfortable range (MIDI); null = a middle default that suits most voices with octave matching. */
  range: { low: number; high: number } | null;
  direction: "up" | "up-down";
  maxSteps?: number;
}

/** The tonic of each repetition: a semitone apart, staying inside your range with a little room to spare. */
export function planKeys(ex: ExerciseDef, { range, direction, maxSteps = 6 }: KeyPlanOptions): number[] {
  const span = patternSpan(ex);
  const low = range ? range.low + 2 : 60;
  const high = range ? range.high - 2 : 74;
  let first = low;
  let last = high - span;
  if (last < first) first = last = Math.round((low + high - span) / 2);
  const up: number[] = [];
  for (let t = first; t <= last && up.length < maxSteps; t++) up.push(t);
  return direction === "up-down" && up.length > 1 ? [...up, ...up.slice(0, -1).reverse()] : up;
}

const DIVISIONS = 2; // per quarter: eighth notes are the shortest value
const TYPES: Record<number, [string, boolean]> = { 8: ["whole", false], 6: ["half", true], 4: ["half", false], 3: ["quarter", true], 2: ["quarter", false], 1: ["eighth", false] };

function pitchXml(p: Spelled): string {
  return `<pitch><step>${p.step}</step>${p.alter ? `<alter>${p.alter}</alter>` : ""}<octave>${p.octave}</octave></pitch>`;
}

function noteXml(p: Spelled | null, divisions: number, extra = "", chord = false): string {
  const [type, dotted] = TYPES[divisions] ?? ["quarter", false];
  return `<note>${chord ? "<chord/>" : ""}${p ? pitchXml(p) : "<rest/>"}<duration>${divisions}</duration><voice>1</voice><type>${type}</type>${dotted ? "<dot/>" : ""}${extra}</note>`;
}

/** The piano's tonic triad, voiced low so it doesn't cover the singer. */
function chordXml(tonic: number, divisions: number): string {
  let bass = tonic;
  while (bass > 47) bass -= 12;
  while (bass < 36) bass += 12;
  return [1, 8, 10, 12].map((degree, i) => noteXml(spellDegree(bass, degree), divisions, "", i > 0)).join("");
}

/** Bars of the pattern, each a list of [degree, divisions]; throws if a note would cross a barline. */
function patternBars(ex: ExerciseDef): [number, number][][] {
  const bars: [number, number][][] = [];
  let bar: [number, number][] = [];
  let filled = 0;
  for (const n of ex.pattern) {
    const d = Math.round(n.beats * DIVISIONS);
    if (filled + d > 4 * DIVISIONS) throw new Error(`${ex.id}: note crosses a barline`);
    bar.push([n.degree, d]);
    filled += d;
    if (filled === 4 * DIVISIONS) {
      bars.push(bar);
      bar = [];
      filled = 0;
    }
  }
  if (bar.length) throw new Error(`${ex.id}: pattern doesn't fill its last bar`);
  return bars;
}

/**
 * MusicXML for an exercise: for each key, one cue bar (piano chord, voice resting), then
 * the pattern on the syllable with the chord underneath. Voice is the top part, so it's
 * what gets scored.
 */
export function buildExerciseXml(ex: ExerciseDef, tonics: number[]): string {
  const bars = patternBars(ex);
  const meanPitch = tonics.reduce((a, t) => a + t, 0) / tonics.length + patternSpan(ex) / 2;
  const voiceClef = meanPitch < 57 ? "<clef><sign>F</sign><line>4</line></clef>" : "<clef><sign>G</sign><line>2</line></clef>";

  const voice: string[] = [];
  const piano: string[] = [];
  let measure = 0;
  tonics.forEach((tonic, rep) => {
    const fifths = KEYS[((tonic % 12) + 12) % 12][2];
    const first = measure === 0;
    const attrs = (clef: string) =>
      `<attributes>${first ? `<divisions>${DIVISIONS}</divisions>` : ""}<key><fifths>${fifths}</fifths></key>${first ? `<time><beats>4</beats><beat-type>4</beat-type></time>${clef}` : ""}</attributes>`;
    const tempo = first ? `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${ex.bpm}</per-minute></metronome></direction-type><sound tempo="${ex.bpm}"/></direction>` : "";
    const label = `<direction placement="above"><direction-type><words>${rep + 1} of ${tonics.length}</words></direction-type></direction>`;

    // Cue bar: hear the key, get ready.
    measure++;
    voice.push(`<measure number="${measure}">${attrs(voiceClef)}${tempo}${label}${noteXml(null, 8)}</measure>`);
    piano.push(`<measure number="${measure}">${attrs("<clef><sign>F</sign><line>4</line></clef>")}${chordXml(tonic, 8)}</measure>`);

    let noteIndex = 0;
    const total = ex.pattern.length;
    for (const bar of bars) {
      measure++;
      const notes = bar
        .map(([degree, d]) => {
          const i = noteIndex++;
          const glide = ex.glide
            ? `${i > 0 ? '<glissando type="stop" number="1"/>' : ""}${i < total - 1 ? '<glissando type="start" number="1" line-type="solid"/>' : ""}`
            : "";
          const notations = glide ? `<notations>${glide}</notations>` : "";
          const lyric = `<lyric number="1"><syllabic>single</syllabic><text>${ex.syllable}</text></lyric>`;
          return noteXml(spellDegree(tonic, degree), d, `${notations}${lyric}`);
        })
        .join("");
      voice.push(`<measure number="${measure}">${notes}</measure>`);
      piano.push(`<measure number="${measure}">${chordXml(tonic, 8)}</measure>`);
    }
  });
  voice[voice.length - 1] = voice[voice.length - 1].replace("</measure>", '<barline location="right"><bar-style>light-heavy</bar-style></barline></measure>');
  piano[piano.length - 1] = piano[piano.length - 1].replace("</measure>", '<barline location="right"><bar-style>light-heavy</bar-style></barline></measure>');

  return `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
<work><work-title>${ex.name}</work-title></work>
<identification><creator type="composer">Vocal exercise · “${ex.syllable}”</creator></identification>
<part-list><score-part id="P1"><part-name>Voice</part-name></score-part><score-part id="P2"><part-name>Piano</part-name></score-part></part-list>
<part id="P1">${voice.join("\n")}</part>
<part id="P2">${piano.join("\n")}</part>
</score-partwise>`;
}
