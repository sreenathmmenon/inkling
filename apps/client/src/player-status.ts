import { createObjectiveContract } from "../../../packages/runtime/src/objective-contract.js";
import type { PlatformerPlan } from "../../../packages/runtime/src/platformer-layout.js";
import type { PlatformerState } from "../../../packages/runtime/src/platformer.js";

/** The visible status for every newly-created or replayed Lane A game. */
export function freshPlayerState(plan: PlatformerPlan): PlatformerState {
  const objective = createObjectiveContract(plan);
  return {
    status: "playing",
    lives: plan.lives,
    collected: 0,
    collectibleTotal: objective.requiredTotal || plan.collectibles.length,
    assistAvailable: false,
    assistActive: false,
  };
}
