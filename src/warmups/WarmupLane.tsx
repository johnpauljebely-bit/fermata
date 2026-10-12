import { useEffect, useRef, useState } from "react";
import { micErrorText, micState, onMicState, readPitch, releaseMic, startMic, type MicState } from "../audio/mic";
import { pitchFromMidi } from "../music/pitch";
import { useFrame } from "../sing/useFrame";
import { VERDICT_COLOR, type Review, type Sample } from "./review";
import { warmupTime, type Plan, type PlanNote } from "./session";

const SECONDS_VISIBLE = 4;
const NOW_AT = 0.28; // playhead across the width
const GUTTER = 36;
const GOOD = 25;
const CLOSE = 60;

export interface LaneStatus {
  note: PlanNote | null;
  /** Your voice vs the note, in cents (octave-folded), or null when silent. */
  cents: number | null;
}

/**
 * Scrolling piano roll for warm-ups: notes come towards the playhead as bars and your voice
 * is drawn as a line. While a bar is lit (yellow) your line over it is black so you can see
 * it; once the bar has passed and gone grey, the line takes its colour (green in tune, amber
 * close, red off). After the warm-up, `review` turns it into a take you can drag through and
 * tap: each bar shows how it went.
 */
export function WarmupLane({
  plan,
  running,
  compact,
  review,
  picked,
  onStatus,
  onFinished,
  onPick,
}: {
  plan: Plan;
  running: boolean;
  compact?: boolean;
  review: Review | null;
  picked: number | null;
  onStatus: (s: LaneStatus) => void;
  onFinished: (samples: Sample[]) => void;
  onPick: (index: number | null) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [mic, setMic] = useState<MicState>(micState());
  const trail = useRef<{ t: number; midi: number | null; wall: number }[]>([]);
  /** The whole take, kept for the review. */
  const take = useRef<Sample[]>([]);
  const wasRunning = useRef(false);
  const lastStatus = useRef(0);
  /** Review: left edge of the view in seconds, and drag state. */
  const view = useRef(0);
  const drag = useRef<{ x: number; start: number; moved: boolean; v: number; lastX: number; lastT: number } | null>(null);
  const fling = useRef(0);

  useEffect(() => onMicState(setMic), []);
  useEffect(() => {
    void startMic().catch(() => undefined);
    return () => releaseMic();
  }, []);
  useEffect(() => {
    trail.current = [];
    if (running) {
      take.current = [];
      wasRunning.current = true;
    } else if (wasRunning.current) {
      wasRunning.current = false;
      if (take.current.length) onFinished(take.current);
    }
  }, [running, plan]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    view.current = -0.3;
    fling.current = 0;
  }, [review]);

  const reviewing = !!review && !running;

  useFrame((wall) => {
    const c = canvas.current;
    if (!c) return;
    const ratio = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (c.width !== Math.round(w * ratio) || c.height !== Math.round(h * ratio)) {
      c.width = Math.round(w * ratio);
      c.height = Math.round(h * ratio);
    }
    const ctx = c.getContext("2d")!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const css = getComputedStyle(c);
    const col = (v: string) => css.getPropertyValue(v).trim();
    const pps = (w - GUTTER) / SECONDS_VISIBLE;

    // ---- Clock ----
    let now: number;
    if (reviewing) {
      // Momentum after a fling, easing to rest.
      if (!drag.current && Math.abs(fling.current) > 0.01) {
        view.current += fling.current / 60;
        fling.current *= 0.94;
      }
      view.current = Math.max(-0.5, Math.min(plan.end - SECONDS_VISIBLE + 0.5, view.current));
      now = view.current + SECONDS_VISIBLE * NOW_AT;
    } else {
      now = running ? (warmupTime() ?? 0) : 0;
    }

    // ---- Voice ----
    const { midi } = mic === "on" && !reviewing ? readPitch() : { midi: null };
    if (!reviewing) {
      trail.current.push({ t: running ? now : (wall - (trail.current[0]?.wall ?? wall)) / 1000, midi, wall });
      if (running) take.current.push({ t: now, midi });
      if (!running) {
        const tail = SECONDS_VISIBLE * NOW_AT * 1000;
        while (trail.current.length && wall - trail.current[0].wall > tail) trail.current.shift();
      } else while (trail.current.length && now - trail.current[0].t > SECONDS_VISIBLE) trail.current.shift();
    }

    // ---- Vertical scale: the notes in view ----
    const near = plan.notes.filter((n) => n.start < now + SECONDS_VISIBLE && n.start + n.duration > now - SECONDS_VISIBLE * NOW_AT - 1);
    const pitches = (near.length ? near : plan.notes.slice(0, 10)).map((n) => n.midi);
    const centre = (Math.min(...pitches) + Math.max(...pitches)) / 2;
    const span = Math.max(14, Math.max(...pitches) - Math.min(...pitches) + 6);
    const low = Math.floor(centre - span / 2);
    const rowH = h / span;
    const y = (m: number) => h - (m - low + 0.5) * rowH;
    const nowX = GUTTER + (w - GUTTER) * NOW_AT;
    const x = (t: number) => nowX + (t - now) * pps;
    const clampY = (m: number) => y(Math.max(low - 1, Math.min(low + span + 1, m)));

    // ---- Grid ----
    ctx.font = "500 10px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    const named = new Set(pitches);
    let lastLabel = Infinity;
    for (let m = low; m <= low + span; m++) {
      if ([1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12)) {
        ctx.fillStyle = col("--surface");
        ctx.fillRect(GUTTER, y(m) - rowH / 2, w - GUTTER, rowH);
      }
      if ((m % 12 === 0 || named.has(m)) && lastLabel - y(m) >= 11) {
        ctx.fillStyle = col(named.has(m) ? "--ink" : "--ink-2");
        ctx.fillText(pitchFromMidi(m).name, 4, y(m));
        lastLabel = y(m);
      }
    }

    // ---- Bars ----
    const current = running ? (plan.notes.find((n) => now >= n.start && now < n.start + n.duration) ?? null) : null;
    const sungIndex = new Map(plan.notes.filter((n) => !n.cue).map((n, i) => [n, i]));
    for (const n of plan.notes) {
      const x0 = x(n.start);
      const x1 = x(n.start + n.duration);
      if (x1 < GUTTER || x0 > w) continue;
      const left = Math.max(GUTTER, x0 + 1);
      const width = Math.max(3, x1 - left - 1);
      const result = reviewing ? review!.notes[sungIndex.get(n) ?? -1] : undefined;
      ctx.beginPath();
      ctx.roundRect(left, y(n.midi) - rowH * 0.42, width, rowH * 0.84, Math.min(6, rowH * 0.42));
      if (n.cue) {
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = col("--ink-2");
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
        if (rowH > 9 && width > 34) {
          ctx.fillStyle = col("--ink-2");
          ctx.font = "600 10px system-ui, sans-serif";
          ctx.fillText("listen", left + 6, y(n.midi));
        }
      } else if (result) {
        // Review: each bar tinted by how it went; the tapped one is outlined in white.
        ctx.globalAlpha = result.verdict === "silent" ? 0.18 : 0.38;
        ctx.fillStyle = col(VERDICT_COLOR[result.verdict]);
        ctx.fill();
        ctx.globalAlpha = 1;
        if (picked === result.index) {
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      } else {
        ctx.fillStyle = n === current ? col("--lane-active") : col("--lane-bar");
        ctx.fill();
      }
    }

    // ---- Your voice ----
    const points: { t: number; midi: number | null; wall: number }[] = reviewing ? take.current.map((s) => ({ ...s, wall: s.t * 1000 })) : trail.current;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    let prev: { px: number; py: number; wall: number; note: PlanNote | undefined } | null = null;
    for (const p of points) {
      if (p.midi === null) {
        prev = null;
        continue;
      }
      const px = running || reviewing ? x(p.t) : nowX - ((wall - p.wall) / 1000) * pps;
      if (px < GUTTER - 4 || px > w + 4) {
        prev = null;
        continue;
      }
      const note = running || reviewing ? plan.notes.find((n) => !n.cue && p.t >= n.start && p.t < n.start + n.duration) : undefined;
      let shown = p.midi;
      let color = col("--ink-2");
      if (note) {
        shown = p.midi - Math.round((p.midi - note.midi) / 12) * 12;
        const cents = (shown - note.midi) * 100;
        // On the lit yellow bar: black, so it reads. Colour only once that bar has passed.
        color = note === current ? "#111" : col(Math.abs(cents) <= GOOD ? "--good" : Math.abs(cents) <= CLOSE ? "--near" : "--danger");
      }
      const py = clampY(shown);
      if (prev && p.wall - prev.wall < 250 && prev.note === note) {
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(prev.px, prev.py);
        ctx.lineTo(px, py);
        ctx.stroke();
      }
      prev = { px, py, wall: p.wall, note };
    }

    // ---- Live dot + playhead ----
    let status: LaneStatus = { note: current, cents: null };
    if (!reviewing) {
      const latest = trail.current[trail.current.length - 1];
      if (latest?.midi != null) {
        const target = current && !current.cue ? current.midi : null;
        const shown = target === null ? latest.midi : latest.midi - Math.round((latest.midi - target) / 12) * 12;
        status = { note: current, cents: target === null ? null : (shown - target) * 100 };
        ctx.fillStyle = current && !current.cue ? "#111" : col("--accent");
        ctx.strokeStyle = col("--accent");
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(nowX, clampY(shown), 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.fillStyle = col("--accent");
      ctx.fillRect(nowX - 1, 0, 2, h);
    } else {
      // A scrubber showing where in the take you are.
      const frac = Math.max(0, Math.min(1, (view.current + 0.5) / Math.max(1, plan.end - SECONDS_VISIBLE + 1)));
      ctx.fillStyle = "rgba(255,255,255,0.12)";
      ctx.fillRect(GUTTER, h - 4, w - GUTTER, 2);
      ctx.fillStyle = col("--marker");
      ctx.fillRect(GUTTER + frac * (w - GUTTER - 30), h - 5, 30, 4);
    }

    if (!reviewing && wall - lastStatus.current > 120) {
      lastStatus.current = wall;
      onStatus(status);
    }
  });

  // ---- Review: drag to look back (with momentum), tap a bar for feedback ----
  const onPointerDown = (e: React.PointerEvent) => {
    if (!reviewing) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // not a capturable pointer; dragging still works while over the lane
    }
    fling.current = 0;
    drag.current = { x: e.clientX, start: view.current, moved: false, v: 0, lastX: e.clientX, lastT: performance.now() };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !canvas.current) return;
    const pps = (canvas.current.clientWidth - GUTTER) / SECONDS_VISIBLE;
    if (Math.abs(e.clientX - d.x) > 6) d.moved = true;
    view.current = d.start - (e.clientX - d.x) / pps;
    const now = performance.now();
    const dt = Math.max(1, now - d.lastT);
    d.v = (-(e.clientX - d.lastX) / pps / dt) * 1000; // seconds of take per second
    d.lastX = e.clientX;
    d.lastT = now;
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || !canvas.current || !review) return;
    if (d.moved) {
      fling.current = Math.max(-12, Math.min(12, d.v));
      return;
    }
    // Tap: which bar?
    const rect = canvas.current.getBoundingClientRect();
    const w = rect.width;
    const pps = (w - GUTTER) / SECONDS_VISIBLE;
    const now = view.current + SECONDS_VISIBLE * NOW_AT;
    const nowX = GUTTER + (w - GUTTER) * NOW_AT;
    const t = now + (e.clientX - rect.left - nowX) / pps;
    const sung = plan.notes.filter((n) => !n.cue);
    const hit = sung.findIndex((n) => t >= n.start - 0.05 && t <= n.start + n.duration + 0.05);
    onPick(hit >= 0 ? hit : null);
  };

  const error = micErrorText(mic);
  return (
    <div className={`lane ${compact ? "compact" : ""} ${reviewing ? "reviewing" : ""}`}>
      <canvas
        ref={canvas}
        aria-label={reviewing ? "Your take: drag to look back, tap a bar for feedback" : "Notes to sing as bars, your voice as a line"}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (drag.current = null)}
      />
      {reviewing ? <p className="lane-hint">Drag to look back · tap a bar</p> : null}
      {error ? (
        <p className="lane-msg error">
          {error}{" "}
          <button className="link small" onClick={() => void startMic().catch(() => undefined)}>
            Try again
          </button>
        </p>
      ) : mic !== "on" && !reviewing ? (
        <p className="lane-msg">Starting the microphone…</p>
      ) : null}
    </div>
  );
}
