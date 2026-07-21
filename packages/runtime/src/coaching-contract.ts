import type { PlatformerControl } from "./platformer.js";
import type { PlatformerPlan, PlannedEntity } from "./platformer-layout.js";

export interface CoachingContract {
  firstControl: PlatformerControl;
  objectiveTarget: PlannedEntity | null;
  objectiveLabel: "FINISH" | "FIND" | "CLEAR" | "STAY SAFE";
}

/**
 * Produces a recovery instruction using only controls the active game
 * contract actually exposes. Side-view games deliberately never suggest a
 * down control, while free-movement games can use all four directions.
 */
export function createRecoveryCue(
  touchControls: PlatformerPlan["contract"]["touchControls"],
  deltaX: number,
  deltaY: number,
): string {
  if (touchControls === "four_way") {
    const arrow = Math.abs(deltaX) >= Math.abs(deltaY)
      ? deltaX < 0 ? "←" : "→"
      : deltaY < 0 ? "↑" : "↓";
    return `Try ${arrow} toward the glow`;
  }
  if (Math.abs(deltaX) > 12) {
    return `Try ${deltaX < 0 ? "←" : "→"} and jump toward the glow`;
  }
  if (deltaY < 0) return "Try jump ↑ toward the glow";
  return "Try moving, then jump toward the glow";
}

/**
 * Selects the first safe, understandable action from GameSpec-derived engine
 * contracts. It contains no object recognition and cannot specialize for a
 * rocket, animal, vehicle, filename, or any other drawing noun.
 */
export function createCoachingContract(plan: PlatformerPlan): CoachingContract {
  if (plan.goalKind === "defeat_boss" && plan.contract.action === "projectile") {
    return { firstControl: "action", objectiveTarget: plan.goal, objectiveLabel: "CLEAR" };
  }
  if (plan.goalKind === "survive") {
    return {
      firstControl: "right",
      objectiveTarget: null,
      objectiveLabel: "STAY SAFE",
    };
  }
  const firstRequired = plan.collectibles.find((entity) => plan.requiredCollectibleIds.includes(entity.id));
  const objectiveTarget = plan.goalKind === "collect_all" || firstRequired
    ? firstRequired ?? plan.collectibles[0] ?? plan.goal
    : plan.goal;
  const objectiveLabel = plan.goalKind === "collect_all" || firstRequired ? "FIND" : "FINISH";
  if (plan.contract.movement === "auto_ground") {
    return { firstControl: "right", objectiveTarget, objectiveLabel };
  }
  if (plan.contract.movement === "launch") {
    // Firing is the signature launch action, and every winning launch replay
    // must fire at least one shot, so coaching the fire control guarantees an
    // input-backed win in the runtime trace.
    return { firstControl: "jump", objectiveTarget, objectiveLabel };
  }
  if (plan.contract.touchControls === "four_way") {
    const deltaX = objectiveTarget.x - plan.hero.x;
    const deltaY = objectiveTarget.y - plan.hero.y;
    const firstControl: PlatformerControl = Math.abs(deltaX) >= Math.abs(deltaY)
      ? deltaX < 0 ? "left" : "right"
      : deltaY < 0 ? "jump" : "down";
    return { firstControl, objectiveTarget, objectiveLabel };
  }
  return {
    firstControl: objectiveTarget.x < plan.hero.x ? "left" : "right",
    objectiveTarget,
    objectiveLabel,
  };
}
