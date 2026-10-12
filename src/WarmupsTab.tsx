import { useEffect, useMemo, useState } from "react";
import { stop } from "./audio/player";
import { pitchFromMidi } from "./music/pitch";
import { BackButton, PillButton, Toggle } from "./ui";
import { ExerciseSheet } from "./warmups/ExerciseSheet";
import { buildReview, type Review } from "./warmups/review";
import { WarmupLane, type LaneStatus } from "./warmups/WarmupLane";
import { degreeSemitones, EXERCISES, type ExerciseDef } from "./warmups/library";
import { buildPlan, planKeys, RANGES, runWarmup, type RangeId } from "./warmups/session";

/** The shape of the exercise: a bar per note, rising and falling with pitch. */
function Contour({ ex }: { ex: ExerciseDef }) {
  const total = ex.pattern.reduce((a, n) => a + n.beats, 0);
  const span = Math.max(1, ...ex.pattern.map((n) => degreeSemitones(n.degree)));
  const w = 72;
  const h = 40;
  let t = 0;
  const pts = ex.pattern.map((n) => {
    const x = 4 + (t / total) * (w - 8);
    const width = Math.max(3, (n.beats / total) * (w - 8) - 2);
    t += n.beats;
    return { x, width, y: h - 6 - (degreeSemitones(n.degree) / span) * (h - 12) };
  });
  return (
    <svg className="contour" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      {ex.glide ? <polyline points={pts.map((p) => `${p.x + p.width / 2},${p.y}`).join(" ")} /> : null}
      {pts.map((p, i) => (
        <rect key={i} x={p.x} y={p.y - 2} width={p.width} height={4} rx={2} />
      ))}
    </svg>
  );
}

const loadRange = (): RangeId => {
  try {
    const v = localStorage.getItem("snap-play:range");
    return RANGES.some((r) => r.id === v) ? (v as RangeId) : "mid";
  } catch {
    return "mid";
  }
};

export function WarmupsTab() {
  const [range, setRange] = useState<RangeId>(loadRange);
  const [active, setActive] = useState<ExerciseDef | null>(null);

  const pickRange = (r: RangeId) => {
    setRange(r);
    try {
      localStorage.setItem("snap-play:range", r);
    } catch {
      // fine
    }
  };

  if (active) return <Session ex={active} range={range} onBack={() => setActive(null)} />;

  return (
    <main className="tab-page">
      <header className="screen-head">
        <h1>Warm-ups</h1>
      </header>
      <div className="range-pick" role="radiogroup" aria-label="Your voice">
        {RANGES.map((r) => (
          <button key={r.id} role="radio" aria-checked={range === r.id} className={range === r.id ? "on" : ""} onClick={() => pickRange(r.id)}>
            <i aria-hidden>{r.label[0]}</i>
            <span>{r.label.replace(" voice", "")}</span>
          </button>
        ))}
      </div>
      <ul className="ex-grid">
        {EXERCISES.map((ex, i) => (
          <li key={ex.id}>
            <button className={`tile ex-tile ${TILE_GRADIENTS[i % TILE_GRADIENTS.length]}`} onClick={() => setActive(ex)}>
              <span className="tile-label">{ex.name}</span>
              <Contour ex={ex} />
              <span className="ex-foot">
                <span className="dots dots-s">{ex.syllable}</span>
                <span className="tile-unit">{ex.bpm} bpm</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}

/** One gradient per exercise, all taken from the reference designs. */
// Order matches EXERCISES: lip trills, sirens, bratty nay, five-note, octave slides, arpeggio, long tones, nine-note.
const TILE_GRADIENTS = ["g-glucose", "g-range", "g-candy", "g-vitamin", "g-stopwatch", "g-plus", "g-pull", "g-minus"];

function Session({ ex, range, onBack }: { ex: ExerciseDef; range: RangeId; onBack: () => void }) {
  const [shift, setShift] = useState(0);
  const tonics = useMemo(() => planKeys(ex, range).map((t) => t + shift), [ex, range, shift]);
  const plan = useMemo(() => buildPlan(ex, tonics), [ex, tonics]);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<LaneStatus>({ note: null, cents: null });
  const [review, setReview] = useState<Review | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [sheet, setSheet] = useState(() => {
    try {
      return localStorage.getItem("snap-play:warmup-sheet") === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => () => stop(), []);

  const start = () => {
    setReview(null);
    setPicked(null);
    setRunning(true);
    void runWarmup(plan, () => setRunning(false));
  };
  const halt = () => {
    stop();
    setRunning(false);
  };
  const toggleSheet = () => {
    setSheet((v) => {
      try {
        localStorage.setItem("snap-play:warmup-sheet", v ? "0" : "1");
      } catch {
        // fine
      }
      return !v;
    });
  };

  const note = running ? status.note : null;
  const sungIndex = note && !note.cue ? plan.notes.filter((n) => !n.cue).indexOf(note) : null;
  const c = status.cents;
  const words =
    !running
      ? { text: `${plan.reps} rounds · ${pitchFromMidi(tonics[0]).name} up to ${pitchFromMidi(Math.max(...tonics)).name}`, tone: "" }
      : !note
        ? { text: "Get ready…", tone: "" }
        : note.cue
          ? { text: `Listen: your note is ${pitchFromMidi(note.midi).name}`, tone: "" }
          : c === null
            ? { text: `Sing “${ex.syllable}” · ${pitchFromMidi(note.midi).name}`, tone: "" }
            : Math.abs(c) <= 25
              ? { text: "In tune", tone: "good" }
              : Math.abs(c) <= 60
                ? { text: c < 0 ? "A touch higher" : "A touch lower", tone: "near" }
                : { text: c < 0 ? "Go higher ↑" : "Go lower ↓", tone: "far" };

  return (
    <main className="tab-page session">
      <header className="screen-head">
        <BackButton
          label="All warm-ups"
          onClick={() => {
            halt();
            onBack();
          }}
        />
        <h1>{ex.name}</h1>
      </header>
      <div className="tile-row session-row">
        <span className="tile-label">Sheet music</span>
        <Toggle on={sheet} onChange={toggleSheet} label="Sheet music" />
      </div>
      <p className="tab-lede">{ex.how}</p>

      <WarmupLane
        plan={plan}
        running={running}
        compact={sheet}
        review={review}
        picked={picked}
        onStatus={setStatus}
        onFinished={(samples) => {
          const r = buildReview(plan, samples);
          setReview(r.notes.length ? r : null);
        }}
        onPick={setPicked}
      />
      {review && !running ? (
        <ReviewPanel review={review} picked={picked} onClose={() => setPicked(null)} />
      ) : (
      <div className="lane-words" data-tone={words.tone} aria-live="polite">
        {running && note ? <span className="dots dots-m">{pitchFromMidi(note.midi).name}</span> : null}
        <strong>{words.text}</strong>
        {running && note ? <span>Round {note.rep} of {plan.reps}</span> : null}
      </div>
      )}

      {sheet ? <ExerciseSheet ex={ex} tonics={tonics} sungIndex={sungIndex} /> : null}

      <div className="session-actions">
        {running ? (
          <PillButton icon="stop" onClick={halt}>
            Stop
          </PillButton>
        ) : (
          <PillButton icon="arrow" tone="glow" onClick={start}>
            {review ? "Go again" : "Start warm-up"}
          </PillButton>
        )}
        {!running ? (
          <div className="octave-row">
            <button className="seg" onClick={() => setShift((s) => Math.max(-12, s - 12))} disabled={shift <= -12}>
              Octave down
            </button>
            {shift ? (
              <button className="link small" onClick={() => setShift(0)}>
                Normal octave
              </button>
            ) : null}
            <button className="seg" onClick={() => setShift((s) => Math.min(12, s + 12))} disabled={shift >= 12}>
              Octave up
            </button>
          </div>
        ) : null}
      </div>
    </main>
  );
}

/** After a warm-up: the score, what to work on, and the tapped bar's feedback. */
function ReviewPanel({ review, picked, onClose }: { review: Review; picked: number | null; onClose: () => void }) {
  const note = picked === null ? null : review.notes[picked];
  if (note) {
    const tone = note.verdict === "great" || note.verdict === "good" ? "good" : note.verdict === "close" ? "near" : note.verdict === "off" ? "far" : "";
    return (
      <section className="tile g-ink review-card" data-tone={tone} aria-live="polite">
        <div className="tile-row">
          <span className="tile-label">{note.title}</span>
          <button className="round-btn small" onClick={onClose} aria-label="Back to the summary">
            ×
          </button>
        </div>
        <div className="review-score">
          <span className="dots dots-l">{note.verdict === "silent" ? "--" : note.score}</span>
          <span className="tile-unit">{note.verdict === "silent" ? "no voice" : "/ 100"}</span>
          {note.cents !== null ? (
            <span className="review-chip">
              {Math.abs(note.cents) < 5
                ? "dead centre"
                : Math.abs(note.cents) >= 90
                  ? `${Math.round(Math.abs(note.cents) / 100)} semitone${Math.round(Math.abs(note.cents) / 100) > 1 ? "s" : ""} ${note.cents > 0 ? "high" : "low"}`
                  : `${Math.abs(Math.round(note.cents))}¢ ${note.cents > 0 ? "sharp" : "flat"}`}
            </span>
          ) : null}
        </div>
        <p>{note.body}</p>
        {note.tip ? <p className="review-tip">{note.tip}</p> : null}
      </section>
    );
  }
  return (
    <section className="tile g-ink review-card" aria-live="polite">
      <div className="review-score">
        <span className="dots dots-xl">{review.score}</span>
        <span className="tile-unit">/ 100 · {review.headline}</span>
      </div>
      {review.tips.length ? (
        <ul className="review-tips">
          {review.tips.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      ) : null}
      <p className="review-hint">Tap any bar above to see how that note went.</p>
    </section>
  );
}
