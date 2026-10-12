import { useEffect, useRef, useState } from "react";
import { playMidi } from "../audio/player";
import { pitchFromMidi } from "../music/pitch";
import { SingMeter } from "./SingMeter";
import { PillButton } from "../ui";

/** Bottom sheet: sing one note from the score and see how close you are. */
export function SingSheet({ midi, label, onClose }: { midi: number; label?: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [target, setTarget] = useState(midi);
  const written = pitchFromMidi(midi).name;
  const shift = Math.round((target - midi) / 12);

  useEffect(() => {
    ref.current?.showModal();
    void playMidi([midi], 1.4);
  }, [midi]);

  const octave = (delta: number) => {
    const next = Math.max(36, Math.min(96, target + delta));
    setTarget(next);
    void playMidi([next], 1.4);
  };

  return (
    <dialog ref={ref} className="sheet" onClose={onClose} onClick={(e) => e.target === ref.current && ref.current.close()}>
      <div className="sheet-body">
        <span className="grabber" aria-hidden />
        <div className="sing-head">
          <div>
            <span className="tile-label">Sing</span>
            <h2 className="dots dots-l">
              {pitchFromMidi(target).name}
              {shift ? <small> ({written} {shift < 0 ? "↓" : "↑"} {Math.abs(shift)} oct.)</small> : null}
            </h2>
            {label ? <p className="muted">{label}</p> : null}
          </div>
          <button className="chip" onClick={() => void playMidi([target], 1.4)}>
            ▶ Hear it
          </button>
        </div>
        <SingMeter target={target} onOctave={octave} />
        <div className="octave-row">
          <button className="seg" onClick={() => octave(-12)}>
            Octave down
          </button>
          {shift ? (
            <button className="link small" onClick={() => setTarget(midi)}>
              Back to {written}
            </button>
          ) : null}
          <button className="seg" onClick={() => octave(12)}>
            Octave up
          </button>
        </div>
        <PillButton onClick={() => ref.current?.close()}>Done</PillButton>
      </div>
    </dialog>
  );
}
