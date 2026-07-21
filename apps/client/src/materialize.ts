/**
 * The materialize moment: while the pipeline runs, the child's own prepared
 * strokes (the #drawing-preview image already on the page) progressively lift
 * off the paper — the shadow deepens, the drawing inflates — so the wait reads
 * as their drawing becoming the game world.
 *
 * Honesty contract: progress advances ONLY when a real SSE pipeline stage
 * arrives (checking → understanding → animating → testing). There is no
 * fixed-duration timeline and no simulated progress; between stages the
 * treatment simply holds. Completion is not celebrated here — the drawing
 * returns to rest and the existing game reveal takes over. Reduced motion is
 * honored by the global 90-motion-preferences rules, which collapse the CSS
 * transitions into discrete static steps. The treatment is presentation-only
 * CSS on the preview element; the child's artwork pixels are never modified.
 */

export const MATERIALIZE_STAGES = ["checking", "understanding", "animating", "testing"] as const;

export type MaterializeStage = (typeof MATERIALIZE_STAGES)[number];

export interface MaterializeTreatment {
  stage: MaterializeStage;
  /** Fraction of real pipeline stages reached, in (0, 1]. */
  progress: number;
}

/**
 * Maps a real stage arrival onto its ink-lift progress. Returns null for an
 * unknown stage and for any arrival that would repeat or move progress
 * backwards, so a duplicated or out-of-order SSE event can never un-lift or
 * re-animate the drawing.
 */
export function materializeTreatment(
  stage: string,
  previousProgress = 0,
): MaterializeTreatment | null {
  const index = (MATERIALIZE_STAGES as readonly string[]).indexOf(stage);
  if (index < 0) return null;
  const progress = (index + 1) / MATERIALIZE_STAGES.length;
  if (progress <= previousProgress) return null;
  return { stage: MATERIALIZE_STAGES[index]!, progress };
}

/** The DOM surface the controller writes to; element-shaped for unit tests. */
export interface MaterializeHost {
  style: {
    setProperty(name: string, value: string): void;
    removeProperty(name: string): void;
  };
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

export interface MaterializeController {
  /** Reflects a real SSE stage arrival into the page treatment. */
  stageReached(stage: string): void;
  /** Returns the drawing to rest: cancel, failure, or hand-off to the game. */
  reset(): void;
  progress(): number;
}

export function attachMaterialize(host: MaterializeHost): MaterializeController {
  let current = 0;
  return {
    stageReached(stage: string): void {
      const treatment = materializeTreatment(stage, current);
      if (!treatment) return;
      current = treatment.progress;
      host.style.setProperty("--materialize", String(treatment.progress));
      host.setAttribute("data-materialize-stage", treatment.stage);
    },
    reset(): void {
      current = 0;
      host.style.removeProperty("--materialize");
      host.removeAttribute("data-materialize-stage");
    },
    progress: () => current,
  };
}
