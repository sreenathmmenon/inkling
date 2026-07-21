/**
 * State machine for the one-tap reinterpretation toggle: the same drawing
 * played as the alternate genre the pipeline already computed. Pure data in,
 * pure data out — the DOM wiring in main.ts renders whatever this says.
 *
 * Honesty rules enforced here rather than in the UI:
 * - A machine exists only when a genuine alternate genre exists. Unanimous
 *   genre reads produce null, so no fake choice can ever render.
 * - The alternate slot is filled only with a document whose certified genre
 *   really differs from the original; if the server's mandatory certification
 *   ladder collapsed the alternate back onto the original genre, the offer is
 *   withdrawn entirely instead of relabeled.
 */

import type { CertificationOutcome } from "./interpretation-status.js";

export interface ReinterpretationVariant {
  /** The full playable document for this way of playing the drawing. */
  document: unknown;
  /** The client-side runtime certification outcome for this document. */
  certification: CertificationOutcome;
}

export type ReinterpretationPhase = "offer" | "requesting";

export interface ReinterpretationMachine {
  phase: ReinterpretationPhase;
  originalGenre: string;
  alternateGenre: string;
  original: ReinterpretationVariant;
  /** Cached once the certified alternate arrives; toggling is then instant. */
  alternate: ReinterpretationVariant | null;
  active: "original" | "alternate";
}

/**
 * A machine for a newly arrived world, or null when no genuine alternate
 * exists (missing, unnamed, or identical to the played genre).
 */
export function createReinterpretation(
  originalGenre: unknown,
  alternateGenre: unknown,
  original: ReinterpretationVariant,
): ReinterpretationMachine | null {
  if (typeof originalGenre !== "string" || originalGenre.length === 0) return null;
  if (typeof alternateGenre !== "string" || alternateGenre.length === 0) return null;
  if (alternateGenre === originalGenre) return null;
  return {
    phase: "offer",
    originalGenre,
    alternateGenre,
    original,
    alternate: null,
    active: "original",
  };
}

/** The genre a tap of the control would switch the child to right now. */
export function offeredGenre(machine: ReinterpretationMachine): string {
  return machine.active === "original" ? machine.alternateGenre : machine.originalGenre;
}

/** The variant currently playing. */
export function activeReinterpretationVariant(
  machine: ReinterpretationMachine,
): ReinterpretationVariant {
  return machine.active === "alternate" && machine.alternate
    ? machine.alternate
    : machine.original;
}

/** Marks the server round-trip in flight. Only valid before a cached alternate exists. */
export function beginReinterpretationRequest(
  machine: ReinterpretationMachine,
): ReinterpretationMachine {
  if (machine.alternate || machine.phase === "requesting") return machine;
  return { ...machine, phase: "requesting" };
}

/**
 * The certified alternate arrived. Returns the machine playing the alternate,
 * or null when `certifiedGenre` no longer differs from the original genre —
 * the ladder collapsed the choice, so the control must disappear rather than
 * present the same game twice.
 */
export function reinterpretationArrived(
  machine: ReinterpretationMachine,
  alternate: ReinterpretationVariant,
  certifiedGenre: unknown,
): ReinterpretationMachine | null {
  if (typeof certifiedGenre !== "string" || certifiedGenre === machine.originalGenre) return null;
  return {
    ...machine,
    phase: "offer",
    alternateGenre: certifiedGenre,
    alternate,
    active: "alternate",
  };
}

export type ReinterpretationArrival =
  | { disposition: "withdrawn" }
  | { disposition: "mediate" }
  | { disposition: "play"; machine: ReinterpretationMachine };

/**
 * Routes a certified arrival by its PlayContract verdict. A reinterpreted
 * world whose outcome is needs_recast must go through the same safe-offer
 * mediation as a first scan — never straight to play — and the toggle is
 * withdrawn, because no honest instant swap exists to a world the child has
 * not yet accepted.
 */
export function routeReinterpretationArrival(
  machine: ReinterpretationMachine,
  alternate: ReinterpretationVariant,
  certifiedGenre: unknown,
  readinessOutcome: unknown,
): ReinterpretationArrival {
  const next = reinterpretationArrived(machine, alternate, certifiedGenre);
  if (!next) return { disposition: "withdrawn" };
  if (readinessOutcome === "needs_recast") return { disposition: "mediate" };
  return { disposition: "play", machine: next };
}

/** The round-trip failed; the child keeps their game and the offer stays. */
export function reinterpretationFailed(
  machine: ReinterpretationMachine,
): ReinterpretationMachine {
  return { ...machine, phase: "offer" };
}

/** Swaps between the two certified versions. No-op until both exist. */
export function toggleReinterpretation(
  machine: ReinterpretationMachine,
): ReinterpretationMachine {
  if (!machine.alternate || machine.phase === "requesting") return machine;
  return { ...machine, active: machine.active === "original" ? "alternate" : "original" };
}
