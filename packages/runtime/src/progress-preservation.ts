import type { PlatformerPlan } from "./platformer-layout.js";

/**
 * The honest carry-forward rule for the physical rescan loop. When a child
 * edits their paper and rescans, previously collected bonuses stay collected
 * only where the new world still allows it:
 *
 * - The id must still exist as a collectible in the merged world; an entity
 *   the child erased (or the model dropped) starts fresh.
 * - Nothing required to finish is ever pre-collected: if the goal is
 *   collect_all, gathering IS the game, so every collectible starts fresh;
 *   ids in requiredCollectibleIds (relationship keys that gate doors) must be
 *   earned again so the door-unlock sequence the certifier replayed stays the
 *   sequence the child plays.
 *
 * Deterministic: output order follows the input order, deduplicated. The
 * solver and certification replay never use this — they always replay fresh —
 * so carrying bonuses can never affect whether a world is finishable.
 */
export function carriedCollectibleIds(
  plan: PlatformerPlan,
  previouslyCollected: Iterable<string>,
): string[] {
  if (plan.goalKind === "collect_all") return [];
  const present = new Set(plan.collectibles.map((collectible) => collectible.id));
  const required = new Set(plan.requiredCollectibleIds);
  const carried: string[] = [];
  for (const id of previouslyCollected) {
    if (present.has(id) && !required.has(id) && !carried.includes(id)) carried.push(id);
  }
  return carried;
}
