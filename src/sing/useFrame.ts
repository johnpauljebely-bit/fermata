import { useEffect, useRef } from "react";

/** Runs `fn(now)` every animation frame while mounted (and `active`). */
export function useFrame(fn: (now: number) => void, active = true) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return;
    let id = requestAnimationFrame(function loop(now) {
      ref.current(now);
      id = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(id);
  }, [active]);
}
