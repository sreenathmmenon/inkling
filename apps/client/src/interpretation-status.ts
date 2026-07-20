/**
 * Child-facing honesty layer. Everything the pipeline records about how a
 * world was simplified, and whether the real-runtime check finished, is
 * translated here into short, positive, allowlisted copy. No internal
 * vocabulary (recast, ladder, contract, pipeline, solvability, P8, Lane A)
 * may ever reach the page — the tests enforce that on this module's output.
 */

export type CertificationOutcome = "certified" | "unverified" | "not_applicable";

/** Ladder flags ordered from smallest to largest simplification. */
const SIMPLIFICATION_COPY: ReadonlyArray<readonly [string, string]> = [
  ["p8_bounded_adjustment", "I nudged one tricky bit so you can finish it!"],
  ["p8_reach_support", "I added a little stepping stone so you can reach everything!"],
  ["p8_optional_pickups", "Some treasures were extra tricky, so they are part of the scenery now!"],
  ["collect_all_fallback", "Your goal: collect everything you drew!"],
  ["survive_mode_fallback", "Your goal: stay safe until the timer runs out!"],
  ["p8_guarded_floor", "I kept your drawing and added a safe path so you can finish!"],
  ["p8_safety_recast", "I made this one a little simpler so you can finish it!"],
  ["deterministic_fallback", "I made this one a little simpler so you can finish it!"],
  ["lane_a_fallback", "I made this one a little simpler so you can finish it!"],
];

/** The single most significant simplification message, or null when untouched. */
export function simplificationNotice(flags: readonly string[]): string | null {
  for (let index = SIMPLIFICATION_COPY.length - 1; index >= 0; index -= 1) {
    const entry = SIMPLIFICATION_COPY[index];
    if (entry && flags.includes(entry[0])) return entry[1];
  }
  return null;
}

export function certificationNotice(outcome: CertificationOutcome): string | null {
  if (outcome !== "unverified") return null;
  return "Still double-checking this one — it might be a little wobbly.";
}

/**
 * The complete interpretation-note line for the current game. Empty string
 * means there is nothing the child needs to be told.
 */
export function interpretationNoteText(
  readinessOutcome: string | undefined,
  flags: readonly string[],
  certification: CertificationOutcome,
): string {
  const parts: string[] = [];
  const simplified = simplificationNotice(flags);
  if (simplified) {
    parts.push(simplified);
  } else if (readinessOutcome === "needs_recast") {
    parts.push("Your art stayed the same; some game actions were simplified.");
  } else if (readinessOutcome === "related_fallback") {
    parts.push("Your art is here in a clear, finishable adventure.");
  }
  const checking = certificationNotice(certification);
  if (checking) parts.push(checking);
  if (parts.length === 0) return "";
  return `Ready to play · ${parts.join(" ")}`;
}

const INTERNAL_TERMS = /recast|ladder|pipeline|solvab|contract|fallback|deterministic|lane a|p8|p2\b/i;
const MAX_CHIPS = 4;

/**
 * The model's own child-readable guesses, shown as correctable chips. Any
 * assumption that leaks internal vocabulary is filtered rather than shown.
 */
export function assumptionChips(assumptions: readonly string[]): string[] {
  const chips: string[] = [];
  for (const assumption of assumptions) {
    const text = assumption.trim();
    if (!text || text.length > 160) continue;
    if (INTERNAL_TERMS.test(text)) continue;
    if (chips.includes(text)) continue;
    chips.push(text);
    if (chips.length === MAX_CHIPS) break;
  }
  return chips;
}

const MAX_CORRECTIONS = 6;
const MAX_CORRECTION_LENGTH = 240;

/**
 * The corrections list to send when a child rejects a guess. Corrections are
 * the rejected guesses verbatim; the server re-derives the whole game through
 * every ordered gate with this context.
 */
export function appendCorrection(existing: readonly string[], rejectedGuess: string): string[] {
  const guess = rejectedGuess.trim().slice(0, MAX_CORRECTION_LENGTH);
  if (!guess) return [...existing];
  const merged = existing.includes(guess) ? [...existing] : [...existing, guess];
  return merged.slice(-MAX_CORRECTIONS);
}
