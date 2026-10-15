// The play button's face: one of SD Center's soft gradient avatars (@oreo-design/avatar),
// with its colour blobs drifting. While playing they swirl and surge.
import { useEffect, useMemo, useRef } from "react";
import { createAvatar } from "@oreo-design/avatar";

/** The same twelve SD Center uses. */
export const AVATARS = [
  { shape: "bloom", palette: "rose-milk" },
  { shape: "silk", palette: "lilac-silk" },
  { shape: "flare", palette: "peach-cream" },
  { shape: "nova", palette: "aurora-pink" },
  { shape: "void", palette: "magenta-void" },
  { shape: "jade", palette: "jade-cream" },
  { shape: "bloom", palette: "coral-mist" },
  { shape: "silk", palette: "moon-pearl" },
  { shape: "flare", palette: "sunset-punch" },
  { shape: "nova", palette: "candy-blue" },
  { shape: "void", palette: "teal-void" },
  { shape: "jade", palette: "mint-milk" },
] as const;

export const ORB_COUNT = AVATARS.length;

/** The avatar's SVG with each colour layer wrapped, so CSS can move it. */
function orbSvg(index: number): string {
  const a = AVATARS[index % ORB_COUNT];
  const { svg } = createAvatar({ shape: a.shape, palette: a.palette, size: 64, background: null, variantId: `fermata-${index}` });
  let i = 0;
  return svg
    .replace(/<title>[^<]*<\/title>/, "")
    .replace(/<g transform="translate\([^"]*\)[^>]*>[\s\S]*?<\/g>/g, (layer) => `<g class="orb-spin"><g class="orb-blob orb-b${i++}">${layer}</g></g>`);
}

/** The play button uses "candy blue". */
const PLAY_ORB = AVATARS.findIndex((a) => a.palette === "candy-blue");

/** Resting spin (deg/s), how hard each note pushes it, and how fast the push fades (s). */
const REST = 18;
const KICK = 240;
const FADE = 0.4;

/**
 * `playing`: the swirl is driven by the music. Every change of `pulse` (a new note starting)
 * pushes it round; between notes it coasts down, so a held note slows it to a drift.
 */
export function PlayOrb({ index = PLAY_ORB, playing = false, pulse }: { index?: number; playing?: boolean; pulse?: unknown }) {
  const html = useMemo(() => orbSvg(index), [index]);
  const face = useRef<HTMLSpanElement>(null);
  const motion = useRef({ angle: 0, speed: REST });

  useEffect(() => {
    if (playing) motion.current.speed += KICK;
  }, [pulse]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!playing) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let last = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const m = motion.current;
      m.speed = Math.min(900, REST + (m.speed - REST) * Math.exp(-dt / FADE));
      m.angle = (m.angle + m.speed * dt) % 360000;
      face.current?.style.setProperty("--spin", `${m.angle}deg`);
      face.current?.style.setProperty("--energy", String(Math.min(1, (m.speed - REST) / 500)));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  return <span ref={face} className="orb-face" aria-hidden dangerouslySetInnerHTML={{ __html: html }} />;
}
