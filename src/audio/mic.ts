import { PitchDetector } from "pitchy";
import * as Tone from "tone";
import { setAudioSession, unlockAudio } from "./piano";

/**
 * The microphone, as a pitch reader. Shared by the tuner, warm-ups and "sing this note".
 * Raw voice (no echo cancelling / noise suppression / auto gain): those filters bend pitch.
 */
const SIZE = 2048;
const MIN_CLARITY = 0.88;
const MIN_RMS = 0.012;

let stream: MediaStream | null = null;
let analyser: AnalyserNode | null = null;
let detector: PitchDetector<Float32Array> | null = null;
let buffer = new Float32Array(SIZE);
let starting: Promise<void> | null = null;
let users = 0;
const recent: number[] = [];

export type MicState = "off" | "starting" | "on" | "denied" | "error";
let state: MicState = "off";
const listeners = new Set<(s: MicState) => void>();
const setState = (s: MicState) => {
  state = s;
  listeners.forEach((l) => l(s));
};
export const micState = () => state;
export function onMicState(l: (s: MicState) => void) {
  listeners.add(l);
  return () => void listeners.delete(l);
}

/** Call from a tap. Resolves once pitches are flowing. */
export function startMic(): Promise<void> {
  users++;
  if (stream) return Promise.resolve();
  const unlocking = unlockAudio();
  starting ??= (async () => {
    setState("starting");
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error("insecure"), { name: "Insecure" });
      setAudioSession("play-and-record");
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      await unlocking;
      const ctx = Tone.getContext().rawContext as AudioContext;
      const source = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = SIZE;
      source.connect(analyser);
      buffer = new Float32Array(analyser.fftSize);
      detector = PitchDetector.forFloat32Array(analyser.fftSize);
      detector.minVolumeDecibels = -45;
      setState("on");
      // Everyone stopped needing it while permission was being asked: let it go again.
      if (users === 0) {
        users = 1;
        releaseMic();
      }
    } catch (e) {
      stream = null;
      setState((e as Error).name === "NotAllowedError" ? "denied" : "error");
      throw e;
    } finally {
      starting = null;
    }
  })();
  return starting;
}

/** Releases the mic when nothing is using it any more (the iPhone's orange dot goes away). */
export function releaseMic() {
  users = Math.max(0, users - 1);
  if (users > 0 || !stream) return;
  stream.getTracks().forEach((t) => t.stop());
  stream = null;
  setAudioSession("playback");
  analyser = null;
  recent.length = 0;
  setState("off");
}

export interface Reading {
  /** Fractional MIDI note (60.5 = C4 + 50¢), or null when there's no clear voice. */
  midi: number | null;
  level: number;
}

/** Reads the current pitch. Call once per animation frame; a short median keeps it steady. */
export function readPitch(): Reading {
  if (!analyser || !detector) return { midi: null, level: 0 };
  analyser.getFloatTimeDomainData(buffer);
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
  const rms = Math.sqrt(sum / buffer.length);
  const [hz, clarity] = detector.findPitch(buffer, analyser.context.sampleRate);
  if (!Number.isFinite(hz) || !Number.isFinite(clarity) || rms < MIN_RMS || clarity < MIN_CLARITY || hz < 60 || hz > 1600) {
    recent.length = 0;
    return { midi: null, level: rms };
  }
  const midi = 69 + 12 * Math.log2(hz / 440);
  recent.push(midi);
  if (recent.length > 5) recent.shift();
  const sorted = [...recent].sort((a, b) => a - b);
  return { midi: sorted[sorted.length >> 1], level: rms };
}

export function micErrorText(s: MicState): string | null {
  if (s === "denied") return "Microphone access was blocked. Allow it in your browser settings, then try again.";
  if (s === "error")
    return location.protocol === "http:" && location.hostname !== "localhost"
      ? "Your phone only allows the microphone on secure (https) pages. See the note in the README for a one-time fix."
      : "Couldn't start the microphone.";
  return null;
}
