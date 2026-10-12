import { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import { useEffect, useRef } from "react";
import { buildExerciseXml } from "./generate";
import type { ExerciseDef } from "./library";

type WithSvg = { getSVGGElement?: () => SVGGElement | undefined };

/** The warm-up as sheet music, with the note you should be singing lit up. */
export function ExerciseSheet({ ex, tonics, sungIndex }: { ex: ExerciseDef; tonics: number[]; sungIndex: number | null }) {
  const host = useRef<HTMLDivElement>(null);
  const voiceNotes = useRef<SVGGElement[]>([]);

  useEffect(() => {
    const el = host.current!;
    const o = new OpenSheetMusicDisplay(el, {
      backend: "svg",
      autoResize: false,
      drawTitle: false,
      drawComposer: false,
      drawCredits: false,
      drawPartNames: false,
      disableCursor: true,
      defaultColorMusic: "#000000",
      pageFormat: "Endless",
    });
    let cancelled = false;
    (async () => {
      await o.load(buildExerciseXml(ex, tonics));
      if (cancelled) return;
      o.zoom = el.clientWidth < 420 ? 0.6 : 0.8;
      o.render();
      // The sung notes, in order (voice is the top staff; cue bars are rests there).
      const found: SVGGElement[] = [];
      for (const m of o.Sheet.SourceMeasures) {
        for (const c of m.VerticalSourceStaffEntryContainers) {
          const entry = c.StaffEntries[0];
          for (const ve of entry?.VoiceEntries ?? []) {
            const n = ve.Notes.find((x) => !x.isRest());
            const g = n && (o.EngravingRules.GNote(n) as unknown as WithSvg | undefined)?.getSVGGElement?.();
            if (g) found.push(g);
          }
        }
      }
      voiceNotes.current = found;
    })();
    return () => {
      cancelled = true;
      o.clear();
    };
  }, [ex, tonics.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    voiceNotes.current.forEach((g, i) => g.classList.toggle("is-active", i === sungIndex));
    const g = sungIndex === null ? null : voiceNotes.current[sungIndex];
    if (g && host.current) {
      // Keep the lit note in view inside the sheet box (not the whole page).
      const box = host.current.getBoundingClientRect();
      const r = g.getBoundingClientRect();
      if (r.top < box.top + 10 || r.bottom > box.bottom - 10) host.current.scrollBy({ top: r.top - box.top - box.height * 0.3, behavior: "smooth" });
    }
  }, [sungIndex]);

  return <div ref={host} className="ex-sheet osmd" />;
}
