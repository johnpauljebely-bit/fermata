import * as Tone from "tone";

// Salamander Grand Piano, one sample every minor third (A0 … C8), served from /public.
const FILES: string[] = ["A0"];
for (let o = 1; o <= 7; o++) FILES.push(`C${o}`, `Ds${o}`, `Fs${o}`, `A${o}`);
FILES.push("C8");

let prefetch: Promise<Map<string, ArrayBuffer>> | null = null;
let piano: Promise<Tone.Sampler> | null = null;

/** Downloads the samples early (no AudioContext needed). */
export function prefetchPiano() {
  prefetch ??= Promise.all(
    FILES.map(async (f) => {
      const res = await fetch(`/samples/salamander/${f}.mp3`);
      if (!res.ok) throw new Error(`Piano sample ${f} missing`);
      return [f.replace("s", "#"), await res.arrayBuffer()] as const;
    }),
  ).then((e) => new Map(e));
  return prefetch;
}

// 50 ms of silence. Playing it from a tap makes iOS treat the page as media playback, so web
// audio isn't muted by the ring/silent switch (older iOS ignores navigator.audioSession).
const SILENCE = "data:audio/wav;base64,UklGRrQBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YZABAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA";
let silentClip: HTMLAudioElement | null = null;
function playSilence() {
  try {
    silentClip ??= Object.assign(new Audio(SILENCE), { preload: "auto" });
    silentClip.currentTime = 0;
    void silentClip.play().catch(() => undefined);
  } catch {
    // no HTML audio: nothing to do
  }
}

/** Call straight from a tap, before any await (iOS only lets sound start inside a gesture). */
export function unlockAudio(): Promise<void> {
  setAudioSession("playback");
  playSilence();
  // iOS can leave the context "suspended" or "interrupted" (calls, other apps, locking the
  // phone); resume it on every tap until it's really running.
  const ctx = Tone.getContext();
  if (ctx.state === "running") return Promise.resolve();
  return Tone.start().catch(() => (ctx.rawContext as AudioContext).resume?.());
}

type AudioSessionType = "playback" | "play-and-record" | "auto";

/**
 * iPhone audio routing (Safari 16.4+): "playback" = loud speaker, ignores the silent switch.
 * "play-and-record" while the microphone is on (otherwise iOS drops to the quiet earpiece).
 */
export function setAudioSession(type: AudioSessionType) {
  const session = (navigator as Navigator & { audioSession?: { type: AudioSessionType } }).audioSession;
  if (session && session.type !== type) {
    try {
      session.type = type;
    } catch {
      // older Safari: nothing to do
    }
  }
}

export function getPiano(): Promise<Tone.Sampler> {
  piano ??= (async () => {
    const [files] = await Promise.all([prefetchPiano(), unlockAudio()]);
    const ctx = Tone.getContext();
    const urls: Record<string, AudioBuffer> = {};
    await Promise.all([...files].map(async ([n, data]) => (urls[n] = await ctx.decodeAudioData(data.slice(0)))));
    // Loudness stage: the Salamander samples are recorded quietly, and phone speakers are small.
    // A gentle compressor evens out the dynamics, make-up gain lifts everything, and a limiter
    // stops big chords from distorting.
    const limiter = new Tone.Limiter(-0.8).toDestination();
    const makeup = new Tone.Gain(Tone.dbToGain(9)).connect(limiter);
    const comp = new Tone.Compressor({ threshold: -22, ratio: 3, attack: 0.004, release: 0.2, knee: 8 }).connect(makeup);
    const s = new Tone.Sampler({ urls, release: 1.1 }).connect(comp);
    s.volume.value = 0;
    // ?mute: silent testing (used by the automated checks).
    if (new URLSearchParams(location.search).has("mute")) Tone.getDestination().mute = true;
    await Tone.loaded();
    return s;
  })();
  return piano;
}
