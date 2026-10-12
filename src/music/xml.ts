// MusicXML helpers: join the reader's pieces, repair what would stop it displaying, and
// apply what the AI found (tempo, dynamics, hairpins, wrong notes) — or build a whole score
// from the AI's own transcription.

import type { AIResult, Expression } from "../api";

export function parseXml(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("Invalid MusicXML");
  return doc;
}

export const serializeXml = (doc: Document) => new XMLSerializer().serializeToString(doc);

const child = (parent: Element, tag: string) => Array.from(parent.children).find((c) => c.tagName === tag);
const num = (el: Element | undefined, fallback: number) => {
  const v = Number(el?.textContent);
  return Number.isFinite(v) && el?.textContent?.trim() ? v : fallback;
};
const measuresOf = (part: Element) => Array.from(part.children).filter((c) => c.tagName === "measure");
const partsOf = (doc: Document) => Array.from(doc.getElementsByTagName("part"));

/** Joins pieces read separately (Audiveris splits a score when the layout changes). */
export function mergeScores(xmls: string[]): string {
  const base = parseXml(xmls[0]);
  const baseParts = partsOf(base);
  for (const xml of xmls.slice(1)) {
    partsOf(parseXml(xml)).forEach((part, i) => {
      const target = baseParts[i];
      if (target) for (const m of measuresOf(part)) target.appendChild(base.importNode(m, true));
    });
  }
  for (const part of baseParts) measuresOf(part).forEach((m, i) => m.setAttribute("number", String(i + 1)));
  return serializeXml(base);
}

const NOTE_TYPES: [number, string, boolean][] = [
  [6, "whole", true], [4, "whole", false], [3, "half", true], [2, "half", false], [1.5, "quarter", true],
  [1, "quarter", false], [0.75, "eighth", true], [0.5, "eighth", false], [0.375, "16th", true], [0.25, "16th", false],
  [0.125, "32nd", false], [0.0625, "64th", false],
];
const VALID_TYPES = new Set(["1024th", "512th", "256th", "128th", "64th", "32nd", "16th", "eighth", "quarter", "half", "whole", "breve", "long", "maxima"]);

/** Fixes values that stop a score from displaying (a bar rest lasting 0, a note with no type). */
export function repairMusicXml(doc: Document): number {
  let fixes = 0;
  for (const part of partsOf(doc)) {
    let divisions = 1;
    let barQuarters = 4;
    for (const measure of measuresOf(part)) {
      const attrs = child(measure, "attributes");
      if (attrs) {
        divisions = num(child(attrs, "divisions"), divisions) || 1;
        const time = child(attrs, "time");
        if (time) barQuarters = (num(child(time, "beats"), 4) * 4) / (num(child(time, "beat-type"), 4) || 4);
      }
      for (const note of Array.from(measure.children).filter((c) => c.tagName === "note")) {
        if (child(note, "grace") || child(note, "cue")) continue;
        const rest = child(note, "rest");
        const durationEl = child(note, "duration");
        const duration = num(durationEl, 0);
        if (!(duration > 0)) {
          if (rest) {
            setChild(note, "duration", String(Math.round(barQuarters * divisions)), durationEl);
            fixes++;
          } else if (!child(note, "chord")) {
            note.remove();
            fixes++;
          }
          continue;
        }
        if (rest?.getAttribute("measure") === "yes") continue;
        const type = child(note, "type");
        if (!type || !VALID_TYPES.has(type.textContent ?? "")) {
          const q = duration / divisions;
          const best = NOTE_TYPES.reduce((a, b) => (Math.abs(b[0] - q) < Math.abs(a[0] - q) ? b : a));
          setChild(note, "type", best[1], type, ["duration", "tie", "instrument", "voice"]);
          if (best[2] && !child(note, "dot")) setChild(note, "dot", "", undefined, ["type"]);
          fixes++;
        }
      }
    }
  }
  return fixes;
}

function setChild(parent: Element, tag: string, value: string, existing?: Element, after: string[] = []) {
  if (existing) {
    existing.textContent = value;
    return;
  }
  const el = parent.ownerDocument.createElement(tag);
  el.textContent = value;
  const anchor = after.map((t) => child(parent, t)).filter(Boolean).pop();
  if (anchor) anchor.after(el);
  else parent.appendChild(el);
}

// ---------- positions inside a bar ----------

interface Placed {
  note: Element;
  /** Quarter notes from the start of the bar. */
  at: number;
}

interface BarInfo {
  measure: Element;
  notes: Placed[];
  divisions: number;
  /** Length of one beat of the time signature, in quarter notes. */
  beatQuarters: number;
}

/** Every bar of every part, with each note's onset (quarters). */
function barsByPart(doc: Document): BarInfo[][] {
  return partsOf(doc).map((part) => {
    let divisions = 1;
    let beatQuarters = 1;
    return measuresOf(part).map((measure) => {
      const attrs = child(measure, "attributes");
      if (attrs) {
        divisions = num(child(attrs, "divisions"), divisions) || 1;
        const time = child(attrs, "time");
        if (time) beatQuarters = 4 / (num(child(time, "beat-type"), 4) || 4);
      }
      const notes: Placed[] = [];
      let pos = 0;
      let lastStart = 0;
      for (const el of Array.from(measure.children)) {
        const d = num(child(el, "duration"), 0);
        if (el.tagName === "note") {
          if (child(el, "grace")) continue;
          const start = child(el, "chord") ? lastStart : pos;
          notes.push({ note: el, at: start / divisions });
          if (!child(el, "chord")) {
            lastStart = pos;
            pos += d;
          }
        } else if (el.tagName === "backup") pos -= d;
        else if (el.tagName === "forward") pos += d;
      }
      return { measure, notes, divisions, beatQuarters };
    });
  });
}

const STEPS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "F#4", "Bb3", "C♯5" → spelling + MIDI. */
export function parsePitch(name: string): { step: string; alter: number; octave: number; midi: number } | null {
  const m = /^\s*([A-Ga-g])\s*(##|bb|#|b|♯|♭|x|𝄪|𝄫|n|♮)?\s*(-?\d)\s*$/.exec(name);
  if (!m) return null;
  const step = m[1].toUpperCase();
  const alter = { "#": 1, "♯": 1, "##": 2, x: 2, "𝄪": 2, b: -1, "♭": -1, bb: -2, "𝄫": -2 }[m[2] ?? ""] ?? 0;
  const octave = Number(m[3]);
  return { step, alter, octave, midi: (octave + 1) * 12 + STEPS[step] + alter };
}

function noteMidi(note: Element): number | null {
  const pitch = child(note, "pitch");
  if (!pitch) return null;
  const step = child(pitch, "step")?.textContent?.trim() ?? "C";
  return (num(child(pitch, "octave"), 4) + 1) * 12 + (STEPS[step] ?? 0) + Math.round(num(child(pitch, "alter"), 0));
}

function setPitch(note: Element, p: { step: string; alter: number; octave: number }) {
  const doc = note.ownerDocument;
  const pitch = child(note, "pitch");
  if (!pitch) return;
  pitch.replaceChildren();
  const add = (tag: string, value: string) => {
    const el = doc.createElement(tag);
    el.textContent = value;
    pitch.appendChild(el);
  };
  add("step", p.step);
  if (p.alter) add("alter", String(p.alter));
  add("octave", String(p.octave));
  const accidental = child(note, "accidental");
  const word = { [-2]: "flat-flat", [-1]: "flat", 0: "natural", 1: "sharp", 2: "double-sharp" }[p.alter] ?? "natural";
  if (accidental) accidental.textContent = word;
  else if (p.alter) {
    const el = doc.createElement("accidental");
    el.textContent = word;
    (child(note, "type") ?? pitch).after(el);
  }
}

// ---------- applying the AI's findings ----------

export interface Applied {
  xml: string;
  fixed: { measure: number; from: string; to: string; reason?: string }[];
  addedMarks: number;
}

const DYNAMIC_MARKS = new Set(["ppp", "pp", "p", "mp", "mf", "f", "ff", "fff", "sfz", "fp"]);

/** Applies the AI check to the reader's (merged) score. */
export function applyCheck(xml: string, ai: AIResult): Applied {
  const doc = parseXml(xml);
  repairMusicXml(doc);
  const bars = barsByPart(doc);
  const fixed: Applied["fixed"] = [];

  for (const fix of ai.noteFixes ?? []) {
    const to = parsePitch(fix.to);
    const from = parsePitch(fix.from);
    const bar = bars[(fix.part ?? 1) - 1]?.[fix.measure - 1];
    if (!to || !bar) continue;
    const beatAt = (Math.max(1, fix.beat ?? 1) - 1) * bar.beatQuarters;
    const candidates = bar.notes.filter((n) => noteMidi(n.note) !== null && (!from || noteMidi(n.note) === from.midi));
    if (!candidates.length) continue;
    const best = candidates.reduce((a, b) => (Math.abs(b.at - beatAt) < Math.abs(a.at - beatAt) ? b : a));
    if (Math.abs(best.at - beatAt) > bar.beatQuarters * 1.01) continue;
    setPitch(best.note, to);
    fixed.push({ measure: fix.measure, from: fix.from, to: fix.to, reason: fix.reason });
  }

  const addedMarks = injectExpressions(doc, bars, ai.expressions ?? []);
  if (ai.tempo?.bpm) setStartTempo(doc, ai.tempo.bpm, ai.tempo.text);
  if (ai.title) setTitle(doc, ai.title, ai.composer);
  return { xml: serializeXml(doc), fixed, addedMarks };
}

/** Draws the AI's dynamics and hairpins on the score (where the reader missed them). */
function injectExpressions(doc: Document, bars: BarInfo[][], expressions: Expression[]): number {
  let added = 0;
  const directionAt = (partIndex: number, measure: number, beat: number, body: string, placement = "below") => {
    const bar = bars[partIndex]?.[measure - 1];
    if (!bar) return false;
    const at = (Math.max(1, beat || 1) - 1) * bar.beatQuarters;
    // Insert just before the first note at or after that beat.
    const anchor = bar.notes.find((n) => n.at >= at - 1e-6 && !child(n.note, "chord"))?.note ?? null;
    const el = parseXml(`<direction placement="${placement}"><direction-type>${body}</direction-type></direction>`).documentElement;
    bar.measure.insertBefore(doc.importNode(el, true), anchor);
    return true;
  };
  const hasDynamicIn = (partIndex: number, measure: number) =>
    !!bars[partIndex]?.[measure - 1]?.measure.getElementsByTagName("dynamics").length;
  const hasWedgeIn = (partIndex: number, measure: number) =>
    !!bars[partIndex]?.[measure - 1]?.measure.getElementsByTagName("wedge").length;

  for (const e of expressions) {
    const parts = e.part ? [e.part - 1] : bars.map((_, i) => i).slice(0, 1);
    for (const p of parts) {
      if (e.type === "dynamic" && e.value && DYNAMIC_MARKS.has(e.value) && !hasDynamicIn(p, e.measure)) {
        if (directionAt(p, e.measure, e.beat ?? 1, `<dynamics><${e.value}/></dynamics>`)) added++;
      } else if ((e.type === "crescendo" || e.type === "diminuendo") && e.endMeasure && !hasWedgeIn(p, e.measure)) {
        if (directionAt(p, e.measure, e.beat ?? 1, `<wedge type="${e.type}"/>`)) {
          directionAt(p, e.endMeasure, e.endBeat ?? 1, `<wedge type="stop"/>`);
          added++;
        }
      } else if (e.type === "tempo" && e.bpm && e.measure > 1) {
        const bar = bars[0]?.[e.measure - 1];
        if (bar) {
          const el = parseXml(
            `<direction placement="above"><direction-type><words>${escapeXml(e.text ?? `♩ = ${e.bpm}`)}</words></direction-type><sound tempo="${e.bpm}"/></direction>`,
          ).documentElement;
          bar.measure.insertBefore(doc.importNode(el, true), bar.notes[0]?.note ?? null);
          added++;
        }
      }
    }
  }
  return added;
}

const escapeXml = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);

/** Starting tempo (quarter notes per minute). */
export function setStartTempo(doc: Document, bpm: number, text?: string | null) {
  const first = doc.getElementsByTagName("measure")[0];
  if (!first) return;
  const sounds = Array.from(first.getElementsByTagName("sound")).filter((s) => s.hasAttribute("tempo"));
  if (sounds.length) {
    sounds.forEach((s) => s.setAttribute("tempo", String(bpm)));
    return;
  }
  const words = text ? `<direction-type><words font-weight="bold">${escapeXml(text)}</words></direction-type>` : "";
  const el = parseXml(
    `<direction placement="above">${words}<direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${Math.round(bpm)}</per-minute></metronome></direction-type><sound tempo="${bpm}"/></direction>`,
  ).documentElement;
  first.insertBefore(doc.importNode(el, true), Array.from(first.children).find((c) => c.tagName === "note") ?? null);
}

function setTitle(doc: Document, title: string, composer?: string | null) {
  const root = doc.documentElement;
  let work = child(root, "work");
  if (!work) {
    work = doc.createElement("work");
    root.insertBefore(work, root.firstElementChild);
  }
  let wt = child(work, "work-title");
  if (!wt) {
    wt = doc.createElement("work-title");
    work.appendChild(wt);
  }
  if (!wt.textContent?.trim()) wt.textContent = title;
  if (composer && !doc.querySelector('creator[type="composer"]')) {
    let id = child(root, "identification");
    if (!id) {
      id = doc.createElement("identification");
      work.after(id);
    }
    const c = doc.createElement("creator");
    c.setAttribute("type", "composer");
    c.textContent = composer;
    id.insertBefore(c, id.firstElementChild);
  }
}

// ---------- the AI's own transcription → MusicXML ----------

const DIVISIONS = 8; // per quarter note
const TYPE_UNITS: Record<string, number> = { whole: 32, half: 16, quarter: 8, eighth: 4, "16th": 2, "32nd": 1 };
const CLEFS: Record<string, string> = {
  treble: "<clef><sign>G</sign><line>2</line></clef>",
  bass: "<clef><sign>F</sign><line>4</line></clef>",
  treble8vb: "<clef><sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change></clef>",
};

export function transcriptionToXml(ai: AIResult): string {
  const parts = ai.parts ?? [];
  if (!parts.length) throw new Error("The AI didn't find any music.");
  const beats = ai.time?.beats || 4;
  const beatType = ai.time?.beatType || 4;
  const fifths = ai.key?.fifths ?? 0;
  const bars = Math.max(...parts.map((p) => p.measures?.length ?? 0));

  const partList = parts
    .map((p, i) => `<score-part id="P${i + 1}"><part-name>${escapeXml(p.name || `Part ${i + 1}`)}</part-name></score-part>`)
    .join("");

  const body = parts
    .map((part, pi) => {
      const measures: string[] = [];
      for (let m = 0; m < bars; m++) {
        let inner = "";
        if (m === 0) {
          inner += `<attributes><divisions>${DIVISIONS}</divisions><key><fifths>${fifths}</fifths>${ai.key?.mode ? `<mode>${ai.key.mode}</mode>` : ""}</key><time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time>${CLEFS[part.clef] ?? CLEFS.treble}</attributes>`;
          if (pi === 0 && ai.tempo?.bpm) {
            inner += `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${Math.round(ai.tempo.bpm)}</per-minute></metronome></direction-type><sound tempo="${ai.tempo.bpm}"/></direction>`;
          }
        }
        const events = part.measures?.[m]?.events ?? [];
        if (!events.length) {
          inner += `<note><rest measure="yes"/><duration>${Math.round(beats * (4 / beatType) * DIVISIONS)}</duration></note>`;
        }
        let tiedIn = new Set<number>();
        for (const ev of events) {
          const base = TYPE_UNITS[ev.duration] ?? 8;
          const dots = Math.max(0, Math.min(2, ev.dots ?? 0));
          const units = Math.round(base * (dots === 2 ? 1.75 : dots === 1 ? 1.5 : 1));
          const dotXml = "<dot/>".repeat(dots);
          const type = TYPE_UNITS[ev.duration] ? ev.duration : "quarter";
          const pitches = (ev.pitches ?? []).map(parsePitch).filter((p): p is NonNullable<ReturnType<typeof parsePitch>> => !!p);
          if (!pitches.length) {
            inner += `<note><rest/><duration>${units}</duration><type>${type}</type>${dotXml}</note>`;
            tiedIn = new Set();
            continue;
          }
          const nextTied = new Set<number>();
          pitches.forEach((p, i) => {
            const ties = [tiedIn.has(p.midi) ? "stop" : null, ev.tieToNext ? "start" : null].filter(Boolean) as string[];
            if (ev.tieToNext) nextTied.add(p.midi);
            inner +=
              `<note>${i ? "<chord/>" : ""}<pitch><step>${p.step}</step>${p.alter ? `<alter>${p.alter}</alter>` : ""}<octave>${p.octave}</octave></pitch>` +
              `<duration>${units}</duration>${ties.map((t) => `<tie type="${t}"/>`).join("")}<type>${type}</type>${dotXml}` +
              (ties.length ? `<notations>${ties.map((t) => `<tied type="${t}"/>`).join("")}</notations>` : "") +
              `</note>`;
          });
          tiedIn = nextTied;
        }
        measures.push(`<measure number="${m + 1}">${inner}</measure>`);
      }
      return `<part id="P${i1(pi)}">${measures.join("")}</part>`;
    })
    .join("");

  const xml = `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><work><work-title>${escapeXml(ai.title ?? "")}</work-title></work><part-list>${partList}</part-list>${body}</score-partwise>`;
  const doc = parseXml(xml);
  injectExpressions(doc, barsByPart(doc), ai.expressions ?? []);
  if (ai.composer) setTitle(doc, ai.title ?? "", ai.composer);
  return serializeXml(doc);
}

const i1 = (i: number) => i + 1;

// ---------- reading marks back for playback ----------

export interface Mark {
  part: number; // 0-based
  measure: number; // 0-based
  /** Quarter notes into the bar. */
  at: number;
  kind: "dynamic" | "cresc" | "dim" | "stop";
  value?: string;
}

/** Dynamics and hairpins written in the score (by the reader, the AI, or the composer). */
export function readMarks(xml: string): Mark[] {
  const doc = parseXml(xml);
  const marks: Mark[] = [];
  partsOf(doc).forEach((part, p) => {
    let divisions = 1;
    measuresOf(part).forEach((measure, m) => {
      const attrs = child(measure, "attributes");
      if (attrs) divisions = num(child(attrs, "divisions"), divisions) || 1;
      let pos = 0;
      for (const el of Array.from(measure.children)) {
        const d = num(child(el, "duration"), 0);
        if (el.tagName === "note") {
          if (!child(el, "chord") && !child(el, "grace")) pos += d;
        } else if (el.tagName === "backup") pos -= d;
        else if (el.tagName === "forward") pos += d;
        else if (el.tagName === "direction") {
          const at = (pos + num(child(el, "offset"), 0)) / divisions;
          for (const dyn of Array.from(el.getElementsByTagName("dynamics"))) {
            const value = dyn.firstElementChild?.tagName;
            if (value) marks.push({ part: p, measure: m, at, kind: "dynamic", value });
          }
          for (const wedge of Array.from(el.getElementsByTagName("wedge"))) {
            const t = wedge.getAttribute("type");
            const kind = t === "crescendo" ? "cresc" : t === "diminuendo" ? "dim" : t === "stop" ? "stop" : null;
            if (kind) marks.push({ part: p, measure: m, at, kind });
          }
          for (const w of Array.from(el.getElementsByTagName("words"))) {
            const text = (w.textContent ?? "").toLowerCase();
            if (/\bcresc/.test(text)) marks.push({ part: p, measure: m, at, kind: "cresc" });
            else if (/\b(dim|decresc)/.test(text)) marks.push({ part: p, measure: m, at, kind: "dim" });
          }
        }
      }
    });
  });
  return marks;
}
