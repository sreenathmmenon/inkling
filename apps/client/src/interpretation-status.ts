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

/** The PlayContract blocker that identifies a maze with no way through. */
export const SEALED_MAZE_BLOCKER = "maze_topology_has_no_finishable_route";

export interface SafeOfferInvitation {
  title: string;
  detail: string;
  /** Label for the rescan affordance in the safe-offer panel. */
  rescanAction: string;
  /** Short line for the live status region so assistive tech hears the offer. */
  announcement: string;
}

/**
 * The safe-offer panel copy for a world the runtime cannot faithfully play as
 * declared. A sealed maze gets a warm physical invitation — erase a wall on
 * the paper and rescan — because that is genuinely how the child fixes it.
 * All copy is allowlisted child language; internal vocabulary never appears.
 */
export function safeOfferInvitation(blockers: readonly string[]): SafeOfferInvitation {
  if (blockers.includes(SEALED_MAZE_BLOCKER)) {
    return {
      title: "Your maze needs one open path",
      detail: "Right now the walls close every way through. " +
        "Erase a little wall on your paper, then rescan it — your maze will open up! " +
        "Or play the ready version now.",
      rescanAction: "I erased a wall — rescan my paper",
      announcement: "Your maze has no way through yet. Erase a wall on your paper, then rescan it.",
    };
  }
  return {
    title: "Your world is ready",
    detail: "Your art stayed yours. Inkling chose a clear adventure you can finish.",
    rescanAction: "I changed my paper — rescan it",
    announcement: "Your playable version is ready.",
  };
}

/**
 * Status-region copy announced when the child starts a rescan: the capture
 * flow is open and waiting for a new photo of the changed paper.
 */
export function rescanInviteMessage(): string {
  return "Change your paper — draw something new or erase something — " +
    "then take a new photo. Your world will grow instead of starting over.";
}

/**
 * One clear line after a rescanned world arrives. Says honestly whether
 * earlier treasures carried over or start fresh because the world changed.
 */
export function rescanGrowthNotice(carriedCount: number, previouslyCollectedCount: number): string {
  if (carriedCount > 0) return "Your world grew! The treasures you already found are still yours.";
  if (previouslyCollectedCount > 0) return "Your world changed, so treasures start fresh this time.";
  return "Your world grew! Go see what changed.";
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
