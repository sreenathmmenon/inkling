import type { PlatformerPlan } from "./platformer-layout.js";

export interface ObjectiveContract {
  headline: string;
  instruction: string;
  counterLabel: "Bonus" | "Found" | null;
  requiredTotal: number;
  optionalTotal: number;
  finishRequired: boolean;
}

/**
 * One source of truth for what the player is asked to do and what the
 * deterministic runtime accepts as a win. Wording comes only from GameSpec
 * goal and role contracts; it never guesses names from a drawing or filename.
 */
export function createObjectiveContract(plan: PlatformerPlan): ObjectiveContract {
  const total = plan.collectibles.length;
  if (plan.goalKind === "collect_all") {
    return {
      headline: "Find everything",
      instruction: total === 1 ? "Find the drawn item." : `Find all ${total} drawn items.`,
      counterLabel: total > 0 ? "Found" : null,
      requiredTotal: total,
      optionalTotal: 0,
      finishRequired: false,
    };
  }
  if (plan.requiredCollectibleIds.length > 0) {
    const required = plan.requiredCollectibleIds.length;
    const relationshipKeyIds = new Set(plan.relationships.map((relationship) => relationship.keyId));
    const onlyUnlockItems = plan.requiredCollectibleIds.every((id) => relationshipKeyIds.has(id));
    if (!onlyUnlockItems) {
      return {
        headline: "Find the drawn items",
        instruction: required === 1
          ? "Find the drawn item, then reach the finish."
          : `Find all ${required} drawn items, then reach the finish.`,
        counterLabel: "Found",
        requiredTotal: required,
        optionalTotal: Math.max(0, total - required),
        finishRequired: true,
      };
    }
    return {
      headline: "Unlock the way",
      instruction: required === 1
        ? "Find the drawn key, then reach the finish."
        : `Find all ${required} drawn keys, then reach the finish.`,
      counterLabel: "Found",
      requiredTotal: required,
      optionalTotal: Math.max(0, total - required),
      finishRequired: true,
    };
  }
  if (plan.goalKind === "survive") {
    return {
      headline: "Keep going!",
      instruction: "Move through your world until the timer ends.",
      counterLabel: total > 0 ? "Bonus" : null,
      requiredTotal: 0,
      optionalTotal: total,
      finishRequired: false,
    };
  }
  if (plan.goalKind === "defeat_boss") {
    return {
      headline: "Clear the danger",
      instruction: plan.contract.action === "projectile"
        ? "Move, stay safe, and use the action button."
        : "Reach the marked danger to clear it.",
      counterLabel: total > 0 ? "Bonus" : null,
      requiredTotal: 0,
      optionalTotal: total,
      finishRequired: false,
    };
  }
  return {
    headline: "Reach the finish",
    instruction: total > 0
      ? "Reach the marked finish. Drawn items are a bonus."
      : "Reach the marked finish.",
    counterLabel: total > 0 ? "Bonus" : null,
    requiredTotal: 0,
    optionalTotal: total,
    finishRequired: true,
  };
}
