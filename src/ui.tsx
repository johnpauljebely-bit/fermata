// Small pieces of the visual language (taken from the reference designs):
// tick rulers with a yellow marker, dial rings of ticks, dark pills with a white
// circle button, and the On/Off toggle.

import type { ReactNode } from "react";

/** A horizontal ruler of ticks with a yellow marker. `value` is −1…1 across the ruler (0 = centre). */
export function Ruler({ value = 0, count = 41, className = "" }: { value?: number | null; count?: number; className?: string }) {
  const w = 300;
  const h = 34;
  const marker = value === null ? null : w / 2 + Math.max(-1, Math.min(1, value)) * (w / 2 - 4);
  return (
    <svg className={`ruler ${className}`} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      {Array.from({ length: count }, (_, i) => {
        const x = 4 + (i * (w - 8)) / (count - 1);
        const major = i % 5 === 0;
        // Ticks fade out towards both ends, like the reference.
        const fade = 1 - Math.abs(i - (count - 1) / 2) / ((count - 1) / 2);
        return <line key={i} x1={x} x2={x} y1={major ? 6 : 11} y2={h - (major ? 6 : 11)} style={{ opacity: 0.18 + fade * 0.6 }} />;
      })}
      {marker !== null ? <line className="ruler-mark" x1={marker} x2={marker} y1={1} y2={h - 1} /> : null}
    </svg>
  );
}

/** A ring of ticks; `progress` (0…1) lights them up with the yellow hatch from the reference. */
export function Dial({ progress = 0, size = 240, ticks = 72, children }: { progress?: number; size?: number; ticks?: number; children?: ReactNode }) {
  const r = size / 2;
  const lit = Math.round(progress * ticks);
  return (
    <div className="dial" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle cx={r} cy={r} r={r * 0.62} className="dial-orbit" />
        {Array.from({ length: ticks }, (_, i) => {
          const a = (i / ticks) * Math.PI * 2 - Math.PI / 2;
          const major = i % 6 === 0;
          const r1 = r - 4;
          const r2 = r - (major ? 16 : 10);
          return (
            <line
              key={i}
              className={i < lit ? "dial-tick lit" : "dial-tick"}
              x1={r + Math.cos(a) * r1}
              y1={r + Math.sin(a) * r1}
              x2={r + Math.cos(a) * r2}
              y2={r + Math.sin(a) * r2}
            />
          );
        })}
      </svg>
      <div className="dial-centre">{children}</div>
    </div>
  );
}

/** The dark pill with a white circle on the right ("Start tracking ⊕" in the reference). */
export function PillButton({
  children,
  icon = "arrow",
  onClick,
  disabled,
  tone = "dark",
}: {
  children: ReactNode;
  icon?: "arrow" | "plus" | "stop" | "play";
  onClick?: () => void;
  disabled?: boolean;
  tone?: "dark" | "glow";
}) {
  return (
    <button className={`pill-btn ${tone}`} onClick={onClick} disabled={disabled}>
      <span>{children}</span>
      <i aria-hidden>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          {icon === "arrow" ? <path d="M5 12h14M13 6l6 6-6 6" /> : null}
          {icon === "plus" ? <path d="M12 5v14M5 12h14" /> : null}
          {icon === "stop" ? <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" /> : null}
          {icon === "play" ? <path d="M9 6.5v11l9-5.5z" fill="currentColor" stroke="none" /> : null}
        </svg>
      </i>
    </button>
  );
}

/** The "On ●" toggle from the reference. */
export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button className={`toggle ${on ? "on" : ""}`} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}>
      <span>{on ? "On" : "Off"}</span>
      <i aria-hidden />
    </button>
  );
}

/** Round back button (← in a dark circle). */
export function BackButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button className="round-btn" onClick={onClick} aria-label={label}>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M19 12H5M11 6l-6 6 6 6" />
      </svg>
    </button>
  );
}
