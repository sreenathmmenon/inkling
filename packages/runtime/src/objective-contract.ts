import type { PlatformerPlan } from "./platformer-layout.js";

export interface ObjectiveContract {
  headline: string;
  instruction: string;
  counterLabel: "Bonus" | "Found" | null;
  requiredTotal: number;
  optionalTotal: number;
}

/**
 * One source of truth for what the player is asked to do and what the
 * deterministic runtime accepts as a win. Wording comes only from the
 * GameSpec goal contract; it never guesses names from a drawing or filename.
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
    };
  }
  if (plan.goalKind === "survive") {
    return {
      headline: "Stay safe",
      instruction: "Keep moving until the timer ends.",
      counterLabel: total > 0 ? "Bonus" : null,
      requiredTotal: 0,
      optionalTotal: total,
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
  };
}
