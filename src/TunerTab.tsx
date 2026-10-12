import { useEffect, useRef, useState } from "react";
import { micErrorText, micState, onMicState, readPitch, releaseMic, startMic, type MicState } from "./audio/mic";
import { playMidi } from "./audio/player";
import { pitchFromMidi } from "./music/pitch";
import { useFrame } from "./sing/useFrame";
import { PillButton, Ruler, Toggle } from "./ui";

const MAX_ANGLE = 62; // degrees at ±50¢
const TRAIL_SECONDS = 6;
const GOOD = 10;
const OK = 25;
// Critically damped needle spring (no overshoot): response 0.22 s.
const RESPONSE = 0.22;
const STIFFNESS = ((2 * Math.PI) / RESPONSE) ** 2;
const DAMPING = (4 * Math.PI) / RESPONSE;

/** A tuner: the note you're singing and how far off it is. */
export function TunerTab() {
  const [mic, setMic] = useState<MicState>(micState());
  const using = useRef(false);
  const [, setUsing] = useState(false);
  const noteRef = useRef<HTMLSpanElement>(null);
  const subRef = useRef<HTMLSpanElement>(null);
  const centsRef = useRef<HTMLSpanElement>(null);
  const hzRef = useRef<HTMLSpanElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const trailRef = useRef<HTMLCanvasElement>(null);
  const spring = useRef({ angle: 0, velocity: 0, last: 0 });
  const held = useRef<{ midi: number; at: number } | null>(null);
  const trail = useRef<{ t: number; midi: number | null }[]>([]);

  useEffect(() => onMicState(setMic), []);
  useEffect(() => () => {
    if (using.current) releaseMic();
  }, []);

  const turnOn = () => {
    if (!using.current) {
      using.current = true;
      setUsing(true);
      void startMic().catch(() => {
        using.current = false;
        setUsing(false);
        releaseMic();
      });
    }
  };

  useFrame((now) => {
    const { midi } = readPitch();
    if (midi !== null) held.current = { midi, at: now };
    const shown = held.current && now - held.current.at < 600 ? held.current : null;
    if (rootRef.current) rootRef.current.dataset.state = midi !== null ? "live" : shown ? "held" : "idle";

    let cents = 0;
    if (shown) {
      const nearest = Math.round(shown.midi);
      cents = (shown.midi - nearest) * 100;
      const p = pitchFromMidi(nearest);
      noteRef.current!.textContent = p.name;
      subRef.current!.textContent = p.solfege.toLowerCase();
      const r = Math.round(cents);
      centsRef.current!.textContent = Math.abs(r) <= GOOD ? "In tune" : `${Math.abs(r)}¢ ${r > 0 ? "sharp · go a bit lower" : "flat · go a bit higher"}`;
      centsRef.current!.dataset.band = Math.abs(cents) <= GOOD ? "good" : Math.abs(cents) <= OK ? "ok" : "off";
      hzRef.current!.textContent = `${(440 * 2 ** ((shown.midi - 69) / 12)).toFixed(1)} Hz`;
    } else {
      noteRef.current!.textContent = "–";
      subRef.current!.textContent = "sing, hum or whistle";
      centsRef.current!.textContent = "";
      centsRef.current!.dataset.band = "";
      hzRef.current!.textContent = "";
    }

    const s = spring.current;
    const dt = Math.min(0.05, (now - (s.last || now)) / 1000);
    s.last = now;
    const target = (Math.max(-50, Math.min(50, cents)) / 50) * MAX_ANGLE;
    s.velocity += (-STIFFNESS * (s.angle - target) - DAMPING * s.velocity) * dt;
    s.angle += s.velocity * dt;
    if (!Number.isFinite(s.angle) || !Number.isFinite(s.velocity)) s.angle = s.velocity = 0;
    // Marker on the ruler: x from 4 to 296 in the ruler's 300-wide box.
    const mark = rulerRef.current?.querySelector(".ruler-mark");
    if (mark) {
      const x = (150 + (s.angle / MAX_ANGLE) * 146).toFixed(1);
      mark.setAttribute("x1", x);
      mark.setAttribute("x2", x);
    }
    drawTrail(trailRef.current, trail.current, now, midi);
  }, mic === "on" && using.current);

  const error = micErrorText(mic);
  const on = mic === "on" && using.current;
  const setOn = (v: boolean) => {
    if (v) turnOn();
    else if (using.current) {
      using.current = false;
      setUsing(false);
      releaseMic();
    }
  };

  return (
    <main className="tab-page tuner" ref={rootRef} data-state="idle">
      <header className="screen-head">
        <h1>Tuner</h1>
      </header>
      <section className="tile g-sage tuner-card">
        <div className="tile-row">
          <span className="tile-label">Microphone</span>
          <Toggle on={on || mic === "starting"} onChange={setOn} label="Microphone" />
        </div>
        <div
          className={`tuner-core ${on ? "" : "tappable"}`}
          role={on ? undefined : "button"}
          tabIndex={on ? undefined : 0}
          onClick={on ? undefined : turnOn}
          onKeyDown={on ? undefined : (e) => (e.key === "Enter" || e.key === " ") && turnOn()}
        >
          <span ref={noteRef} className="dots tuner-note" aria-live="polite">
            –
          </span>
          <span ref={subRef} className="tile-unit tuner-sub">
            {on ? "" : mic === "starting" ? "waiting for permission…" : "tap to start listening"}
          </span>
        </div>
        <div className="tuner-ruler" ref={rulerRef}>
          <Ruler value={0} count={51} />
          <div className="ruler-ends" aria-hidden>
            <span>♭ flat</span>
            <span>sharp ♯</span>
          </div>
        </div>
        <span ref={centsRef} className="tuner-cents" />
      </section>

      <section className="tile g-ink tuner-trail-card">
        <div className="tile-row">
          <span className="tile-label">Last few seconds</span>
          <span ref={hzRef} className="tuner-hz" />
        </div>
        <canvas ref={trailRef} className="tuner-trail" aria-label="Your pitch over the last few seconds" />
      </section>

      <div className="tuner-actions">
        {on ? (
          <PillButton icon="play" onClick={() => void playMidi([held.current ? Math.round(held.current.midi) : 69], 1.6)}>
            Play nearest note
          </PillButton>
        ) : null}
        {error ? <p className="error">{error}</p> : null}
      </div>
    </main>
  );
}

function drawTrail(canvas: HTMLCanvasElement | null, trail: { t: number; midi: number | null }[], now: number, midi: number | null) {
  if (!canvas) return;
  trail.push({ t: now, midi });
  while (trail.length && now - trail[0].t > TRAIL_SECONDS * 1000) trail.shift();
  const ratio = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * ratio)) canvas.width = Math.round(w * ratio);
  if (canvas.height !== Math.round(h * ratio)) canvas.height = Math.round(h * ratio);
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const voiced = trail.filter((p) => p.midi !== null).map((p) => p.midi!);
  if (!voiced.length) return;
  const css = getComputedStyle(canvas);
  const centre = Math.round(voiced[voiced.length - 1]);
  const low = centre - 6;
  const y = (m: number) => h - ((m - low) / 12) * h;
  ctx.font = "500 10px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  for (let m = low; m <= low + 12; m++) {
    ctx.fillStyle = css.getPropertyValue(m === centre ? "--ink-2" : "--line");
    ctx.fillRect(30, y(m), w - 30, 1);
    if (m === centre || m % 12 === 0) ctx.fillText(pitchFromMidi(m).name, 0, y(m));
  }
  ctx.strokeStyle = css.getPropertyValue("--accent");
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";
  ctx.beginPath();
  let drawing = false;
  for (const p of trail) {
    const x = 30 + (1 - (now - p.t) / (TRAIL_SECONDS * 1000)) * (w - 30);
    if (p.midi === null) {
      drawing = false;
      continue;
    }
    if (drawing) ctx.lineTo(x, y(p.midi));
    else ctx.moveTo(x, y(p.midi));
    drawing = true;
  }
  ctx.stroke();
}
