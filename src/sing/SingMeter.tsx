import { useEffect, useRef, useState } from "react";
import { micErrorText, micState, onMicState, readPitch, releaseMic, startMic, type MicState } from "../audio/mic";
import { pitchFromMidi } from "../music/pitch";
import { describe, NoteCoach, type Advice } from "./coach";
import { useFrame } from "./useFrame";

const SPAN = 7; // semitones shown above and below the target
const TRAIL = 4; // seconds

/**
 * Live "how close am I to this note" meter: a ladder centred on the target, your voice as a
 * moving line, and plain-words advice (up / down / other octave / try an octave lower).
 */
export function SingMeter({
  target,
  onOctave,
  compact = false,
}: {
  target: number;
  /** Shown when singing is shaky: move the target an octave (−12 / +12). */
  onOctave?: (delta: number) => void;
  compact?: boolean;
}) {
  const [mic, setMic] = useState<MicState>(micState());
  const [advice, setAdvice] = useState<Advice | null>(null);
  const coach = useRef(new NoteCoach(target));
  const canvas = useRef<HTMLCanvasElement>(null);
  const trail = useRef<{ t: number; midi: number | null }[]>([]);
  const lastUi = useRef(0);

  useEffect(() => onMicState(setMic), []);
  useEffect(() => {
    void startMic().catch(() => undefined);
    return () => releaseMic();
  }, []);
  useEffect(() => {
    coach.current.setTarget(target);
    setAdvice(null);
  }, [target]);

  useFrame((now) => {
    const t = now / 1000;
    const { midi } = readPitch();
    const a = coach.current.push(t, midi);
    trail.current.push({ t, midi });
    while (trail.current.length && t - trail.current[0].t > TRAIL) trail.current.shift();
    draw(canvas.current, trail.current, t, target);
    // Words update ~8×/s: readable, not flickery.
    if (now - lastUi.current > 120) {
      lastUi.current = now;
      setAdvice(a);
    }
  }, mic === "on");

  const words = advice ? describe(advice.verdict) : describe({ kind: "silent" });
  const error = micErrorText(mic);
  const name = pitchFromMidi(target).name;

  return (
    <div className={`sing ${compact ? "compact" : ""}`} data-tone={words.tone}>
      <canvas ref={canvas} className="sing-ladder" aria-hidden />
      <div className="sing-words" aria-live="polite">
        {mic === "on" ? (
          <>
            <strong>{words.title}</strong>
            <span>{words.detail}</span>
            {advice && advice.heldOn > 0.2 ? <span className="held">Held in tune {advice.heldOn.toFixed(1)}s</span> : null}
          </>
        ) : error ? (
          <>
            <span className="error">{error}</span>
            <button className="link small" onClick={() => void startMic().catch(() => undefined)}>
              Try again
            </button>
          </>
        ) : (
          <span>Starting the microphone…</span>
        )}
      </div>
      {advice?.suggest && onOctave ? (
        <div className="sing-suggest" role="status">
          <span>
            {advice.reason === "cracking"
              ? `Cracking on ${name}? Try it an octave ${advice.suggest === "octave-down" ? "lower" : "higher"}.`
              : advice.suggest === "octave-down"
                ? `${name} out of reach? Try it an octave lower.`
                : `${name} too low for you? Try it an octave higher.`}
          </span>
          <button className="chip on" onClick={() => onOctave(advice.suggest === "octave-down" ? -12 : 12)}>
            {advice.suggest === "octave-down" ? "Octave down" : "Octave up"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function draw(canvas: HTMLCanvasElement | null, trail: { t: number; midi: number | null }[], now: number, target: number) {
  if (!canvas) return;
  const ratio = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * ratio)) canvas.width = Math.round(w * ratio);
  if (canvas.height !== Math.round(h * ratio)) canvas.height = Math.round(h * ratio);
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const css = getComputedStyle(canvas);
  const color = (v: string) => css.getPropertyValue(v).trim();
  const y = (m: number) => h / 2 - ((m - target) / SPAN) * (h / 2 - 10);
  const left = 40;

  // In-tune band and semitone lines.
  ctx.fillStyle = color("--good-soft");
  ctx.fillRect(left, y(target + 0.25), w - left, y(target - 0.25) - y(target + 0.25));
  ctx.font = "500 11px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  for (let m = target - SPAN; m <= target + SPAN; m++) {
    const isTarget = m === target;
    const octave = (m - target) % 12 === 0;
    ctx.fillStyle = color(isTarget ? "--ink" : octave ? "--ink-2" : "--line");
    ctx.fillRect(left, Math.round(y(m)), w - left, isTarget ? 2 : 1);
    if (isTarget || Math.abs(m - target) % 2 === 0) {
      ctx.fillStyle = color(isTarget ? "--ink" : "--ink-2");
      ctx.font = `${isTarget ? 700 : 500} ${isTarget ? 13 : 10}px system-ui, sans-serif`;
      ctx.fillText(pitchFromMidi(m).name, 0, y(m));
    }
  }

  // Your voice. Off the ladder? Fold it by octaves so it still shows (dashed).
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  let prev: { x: number; y: number } | null = null;
  let lastPoint: { x: number; y: number; folded: boolean } | null = null;
  for (const p of trail) {
    const x = left + (1 - (now - p.t) / TRAIL) * (w - left - 8);
    if (p.midi === null) {
      prev = null;
      continue;
    }
    let m = p.midi;
    let folded = false;
    while (m - target > SPAN + 0.5) (m -= 12), (folded = true);
    while (target - m > SPAN + 0.5) (m += 12), (folded = true);
    const pt = { x, y: y(m) };
    if (prev && Math.abs(prev.y - pt.y) < h / 3) {
      ctx.strokeStyle = color(Math.abs(p.midi - target) <= 0.25 ? "--good" : folded ? "--ink-2" : "--accent");
      ctx.setLineDash(folded ? [4, 5] : []);
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(pt.x, pt.y);
      ctx.stroke();
    }
    prev = pt;
    lastPoint = { ...pt, folded };
  }
  ctx.setLineDash([]);
  if (lastPoint && now - trail[trail.length - 1].t < 0.1 && trail[trail.length - 1].midi !== null) {
    ctx.fillStyle = color("--accent");
    ctx.beginPath();
    ctx.arc(lastPoint.x, lastPoint.y, 6, 0, Math.PI * 2);
    ctx.fill();
  }
}
