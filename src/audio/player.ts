import * as Tone from "tone";
import type { Entry } from "../music/timeline";
import { toneNoteName } from "../music/pitch";
import { getPiano, unlockAudio } from "./piano";

/**
 * Plays timeline entries on the piano. The Transport runs at 60×rate BPM, so one Transport
 * beat = one second of score time; changing speed is a single bpm change.
 */
const PPQ = 960;

export interface PlayHandlers {
  onActive: (ids: string[]) => void;
  onEnd: () => void;
}

let session = 0;

export function stop() {
  session++;
  const t = Tone.getTransport();
  t.stop();
  t.cancel(0);
  void getPiano().then((p) => p.releaseAll());
}

export function setRate(rate: number) {
  Tone.getTransport().bpm.value = 60 * rate;
}

/** Plays a single note/chord straight away (a tap on the score). */
export async function strike(entry: Entry, rate = 1) {
  const unlocking = unlockAudio();
  const piano = await getPiano();
  await unlocking;
  const now = Tone.now() + 0.01;
  for (const p of entry.pitches) {
    const hold = Math.min(2.5, Math.max(0.35, (p.hold || entry.duration) / rate));
    piano.triggerAttackRelease(toneNoteName(p.midi), hold, now, Math.max(0.45, entry.velocity));
  }
}

/** Plays entries (in order) from `from` seconds; muted staves are skipped. */
export async function play(entries: Entry[], from: number, rate: number, handlers: PlayHandlers) {
  stop();
  const id = session;
  const unlocking = unlockAudio();
  const piano = await getPiano();
  await unlocking;
  if (id !== session) return;

  const t = Tone.getTransport();
  t.PPQ = PPQ;
  setRate(rate);
  const list = entries.filter((e) => e.start + e.duration > from - 1e-6);
  if (!list.length) return handlers.onEnd();
  const origin = Math.min(from, list[0].start);
  const ticks = (s: number) => `${Math.max(1, Math.round((s - origin) * PPQ))}i`;

  // Highlight boundaries: what's sounding after each start/end.
  const moments = new Map<number, { starts: Entry[]; ends: Entry[] }>();
  const at = (s: number) => {
    const k = Math.round(s * PPQ);
    let m = moments.get(k);
    if (!m) moments.set(k, (m = { starts: [], ends: [] }));
    return m;
  };
  for (const e of list) {
    at(Math.max(e.start, origin)).starts.push(e);
    at(e.start + e.duration).ends.push(e);
  }
  const sounding = new Map<string, Entry>();
  for (const [k, m] of [...moments].sort((a, b) => a[0] - b[0])) {
    m.ends.forEach((e) => sounding.delete(e.id));
    m.starts.forEach((e) => sounding.set(e.id, e));
    const ids = [...sounding.keys()];
    t.schedule((time) => Tone.getDraw().schedule(() => id === session && handlers.onActive(ids), time), ticks(k / PPQ));
  }

  for (const e of list) {
    if (e.start < origin - 1e-6) continue;
    t.schedule((time) => {
      const r = t.bpm.value / 60;
      for (const p of e.pitches) {
        if (p.hold <= 0) continue;
        piano.triggerAttackRelease(toneNoteName(p.midi), Math.max(0.05, p.hold / r), time, e.velocity);
      }
    }, ticks(e.start));
  }
  const last = Math.max(...list.map((e) => e.start + Math.max(e.duration, ...e.pitches.map((p) => p.hold))));
  t.schedule((time) => Tone.getDraw().schedule(() => {
    if (id !== session) return;
    stop();
    handlers.onActive([]);
    handlers.onEnd();
  }, time), ticks(last + 0.3));
  t.position = 0;
  t.start("+0.08");
}

/** Plays MIDI notes right away (reference notes, warm-up patterns). `at` = seconds from now. */
export async function playMidi(midis: number[], seconds: number, at = 0, velocity = 0.7) {
  const unlocking = unlockAudio();
  const piano = await getPiano();
  await unlocking;
  const when = Tone.now() + 0.02 + at;
  for (const m of midis) piano.triggerAttackRelease(toneNoteName(m), seconds, when, velocity);
}
