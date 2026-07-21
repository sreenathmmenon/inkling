import type { GameSpec } from "../../../runner/types.js";
import {
  createPlatformerPlan,
  type PlatformerPlan,
} from "./platformer-layout.js";
import { contractForGenre } from "./game-contract.js";
import { keyDoorRelationships } from "./relationship-contract.js";

export type RuntimeCapability =
  | "ground_movement"
  | "four_way_movement"
  | "automatic_ground_movement"
  | "manual_progress_input"
  | "runner_route_topology"
  | "solid_platforms"
  | "contact_hazards"
  | "lives"
  | "reach_goal"
  | "collect_all"
  | "survive_timer"
  | "aimed_projectile"
  | "maze_collision_topology"
  | "rolling_inertia"
  | "launch_trajectory"
  | "multi_step_boss_encounter"
  | "dynamic_entity_behavior"
  | "linked_entity_rules"
  | "key_door_unlock"
  | "declared_rule_modifiers"
  | "water_swim_volume"
  | "surface_ice"
  | "surface_cloud"
  | "surface_launchpad"
  | "declared_genre_movement";

export type PlayContractOutcome =
  | "faithful_ready"
  | "related_fallback"
  | "needs_recast";

export interface RuntimeCapabilityProfile {
  templateId: "lane-a-platformer-v1" | "lane-a-maze-v1" | "lane-a-runner-v1";
  capabilities: readonly RuntimeCapability[];
}

export interface PlayContract {
  format: "inkling-play-contract-v1";
  runtimeVersion: "lane-a-runtime-v1";
  capabilityProfileVersion: "lane-a-capabilities-v1";
  templateId: RuntimeCapabilityProfile["templateId"];
  declaredGenre: string;
  effectiveMovement: PlatformerPlan["contract"]["movement"];
  goalKind: string;
  requiredInteractionEntityIds: string[];
  requiredCapabilities: RuntimeCapability[];
  supportedCapabilities: RuntimeCapability[];
  unsupportedCapabilities: RuntimeCapability[];
  blockers: string[];
  outcome: PlayContractOutcome;
}

/**
 * The capabilities implemented by the production Lane A scene today. This is
 * deliberately narrower than the GameSpec vocabulary: an extracted genre is
 * not considered faithfully ready merely because a generic scene can boot.
 */
export const LANE_A_CAPABILITY_PROFILE: RuntimeCapabilityProfile = {
  templateId: "lane-a-platformer-v1",
  capabilities: [
    "ground_movement",
    "four_way_movement",
    "automatic_ground_movement",
    "solid_platforms",
    "contact_hazards",
    "lives",
    "reach_goal",
    "collect_all",
    "survive_timer",
    "aimed_projectile",
    "key_door_unlock",
    "water_swim_volume",
    "surface_ice",
    "surface_cloud",
    "surface_launchpad",
  ],
};

export const LANE_A_MAZE_CAPABILITY_PROFILE: RuntimeCapabilityProfile = {
  templateId: "lane-a-maze-v1",
  capabilities: [
    "four_way_movement",
    "solid_platforms",
    "contact_hazards",
    "lives",
    "reach_goal",
    "collect_all",
    "survive_timer",
    "key_door_unlock",
    "water_swim_volume",
    "maze_collision_topology",
  ],
};

export const LANE_A_RUNNER_CAPABILITY_PROFILE: RuntimeCapabilityProfile = {
  templateId: "lane-a-runner-v1",
  capabilities: [
    "ground_movement",
    "automatic_ground_movement",
    "manual_progress_input",
    "runner_route_topology",
    "solid_platforms",
    "contact_hazards",
    "lives",
    "reach_goal",
    "collect_all",
    "survive_timer",
    "key_door_unlock",
    "water_swim_volume",
    "surface_ice",
    "surface_cloud",
    "surface_launchpad",
  ],
};

const PLATFORM_ROLES = new Set(["platform", "ice", "cloud", "launchpad"]);
const HAZARD_ROLES = new Set(["hazard", "enemy", "boss"]);

function pushUnique(values: RuntimeCapability[], capability: RuntimeCapability): void {
  if (!values.includes(capability)) values.push(capability);
}

function requiredForGenre(spec: GameSpec, plan: PlatformerPlan): RuntimeCapability[] {
  const required: RuntimeCapability[] = ["lives"];
  if (plan.contract.movement !== contractForGenre(spec.primary_genre).movement) {
    pushUnique(required, "declared_genre_movement");
  }
  if (plan.contract.movement === "ground") pushUnique(required, "ground_movement");
  if (plan.contract.movement === "free") pushUnique(required, "four_way_movement");
  if (plan.contract.movement === "auto_ground") pushUnique(required, "automatic_ground_movement");
  if (plan.contract.movement === "launch") pushUnique(required, "launch_trajectory");

  if (spec.entities.some((entity) => PLATFORM_ROLES.has(entity.role))) {
    pushUnique(required, "solid_platforms");
  }
  if (spec.entities.some((entity) => HAZARD_ROLES.has(entity.role))) {
    pushUnique(required, "contact_hazards");
  }
  if (spec.entities.some((entity) => entity.role === "water")) pushUnique(required, "water_swim_volume");
  if (spec.entities.some((entity) => entity.role === "ice")) pushUnique(required, "surface_ice");
  if (spec.entities.some((entity) => entity.role === "cloud")) pushUnique(required, "surface_cloud");
  if (spec.entities.some((entity) => entity.role === "launchpad")) pushUnique(required, "surface_launchpad");

  switch (spec.primary_genre) {
    case "maze":
      pushUnique(required, "maze_collision_topology");
      break;
    case "runner":
      pushUnique(required, "manual_progress_input");
      if (plan.contract.movement === "auto_ground") pushUnique(required, "runner_route_topology");
      break;
    case "roller":
      pushUnique(required, "rolling_inertia");
      break;
    case "slingshot":
      pushUnique(required, "launch_trajectory");
      break;
  }
  return required;
}

function requiredForGoal(spec: GameSpec, required: RuntimeCapability[]): void {
  if (spec.goal.kind === "collect_all") pushUnique(required, "collect_all");
  else if (spec.goal.kind === "survive") pushUnique(required, "survive_timer");
  else if (spec.goal.kind === "defeat_boss") {
    pushUnique(required, "multi_step_boss_encounter");
    if (spec.primary_genre === "slingshot") {
      pushUnique(required, "aimed_projectile");
    }
  } else pushUnique(required, "reach_goal");
}

function requiredForDeclaredRules(spec: GameSpec, required: RuntimeCapability[]): void {
  if (spec.entities.some((entity) => entity.behavior !== "static" && entity.behavior !== "none")) {
    pushUnique(required, "dynamic_entity_behavior");
  }
  const relationships = keyDoorRelationships(spec);
  const admittedLinks = new Set(relationships.flatMap((relationship) => [
    `${relationship.keyId}\0${relationship.doorId}`,
    `${relationship.doorId}\0${relationship.keyId}`,
  ]));
  if (spec.entities.some((entity) => {
    if (entity.linked_to === undefined || entity.linked_to === null) return false;
    return !admittedLinks.has(`${entity.id}\0${entity.linked_to}`);
  })) {
    pushUnique(required, "linked_entity_rules");
  }
  if (relationships.length > 0) {
    pushUnique(required, "key_door_unlock");
  }
  if ((spec.rules.modifiers?.length ?? 0) > 0) {
    pushUnique(required, "declared_rule_modifiers");
  }
}

function structuralBlockers(spec: GameSpec, plan: PlatformerPlan): string[] {
  const blockers: string[] = [];
  const entityIds = new Set<string>();
  for (const entity of spec.entities) {
    if (entityIds.has(entity.id)) blockers.push("duplicate_entity_id");
    entityIds.add(entity.id);
  }
  if (
    (spec.goal.kind === "reach_goal" || spec.goal.kind === "defeat_boss") &&
    (spec.goal.target_id === null || spec.goal.target_id === undefined || !entityIds.has(spec.goal.target_id))
  ) {
    blockers.push("declared_goal_target_is_missing");
  }
  if (
    spec.goal.kind === "collect_all" &&
    !spec.entities.some((entity) => entity.role === "collectible" || entity.role === "key")
  ) {
    blockers.push("collect_all_has_no_collectible_entities");
  }
  if (
    (plan.contract.movement === "ground" || plan.contract.movement === "auto_ground") &&
    !spec.entities.some((entity) => PLATFORM_ROLES.has(entity.role) && entity.role !== "door")
  ) {
    blockers.push("ground_route_has_no_drawn_support");
  }
  if (plan.contract.id === "maze" && plan.mazeTopologyFallback) {
    blockers.push("maze_topology_has_no_finishable_route");
  }

  const admittedRelationshipLinks = new Set(keyDoorRelationships(spec).flatMap((relationship) => [
    `${relationship.keyId}\0${relationship.doorId}`,
    `${relationship.doorId}\0${relationship.keyId}`,
  ]));
  const links = new Map<string, string>();
  for (const entity of spec.entities) {
    if (entity.linked_to === undefined || entity.linked_to === null) continue;
    if (!entityIds.has(entity.linked_to)) blockers.push("linked_entity_target_is_missing");
    else if (!admittedRelationshipLinks.has(`${entity.id}\0${entity.linked_to}`)) {
      links.set(entity.id, entity.linked_to);
    }
  }
  if (
    spec.entities.some((entity) => entity.role === "key") &&
    spec.entities.some((entity) => entity.role === "door") &&
    keyDoorRelationships(spec).length === 0
  ) {
    blockers.push("key_door_relationship_is_missing");
  }
  for (const start of links.keys()) {
    const seen = new Set<string>();
    let current: string | undefined = start;
    while (current !== undefined && links.has(current)) {
      if (seen.has(current)) {
        blockers.push("linked_entity_cycle");
        break;
      }
      seen.add(current);
      current = links.get(current);
    }
  }
  return blockers;
}

/**
 * Compiles a GameSpec into an auditable statement of what Lane A must execute.
 * It never reads names, filenames, or drawing nouns. Only the schema's genre,
 * goal, role, behavior, links, and rule contracts influence the result.
 */
export interface PlayContractEvidence {
  /**
   * Entities whose declared dynamic behavior produced a certified sandbox
   * motion track. dynamic_entity_behavior counts as supported only when
   * EVERY dynamic-declared entity is certified — one uncertified entity that
   * would stand still makes a "faithful" claim a lie.
   */
  certifiedDynamicEntityIds?: readonly string[];
}

export function createPlayContract(
  gameSpec: GameSpec,
  evidence?: PlayContractEvidence,
): PlayContract {
  const plan = createPlatformerPlan(gameSpec);
  const required = requiredForGenre(gameSpec, plan);
  requiredForGoal(gameSpec, required);
  requiredForDeclaredRules(gameSpec, required);

  const capabilityProfile = plan.contract.id === "maze"
    ? LANE_A_MAZE_CAPABILITY_PROFILE
    : plan.contract.id === "runner"
      ? LANE_A_RUNNER_CAPABILITY_PROFILE
      : LANE_A_CAPABILITY_PROFILE;
  const available = new Set(capabilityProfile.capabilities);
  if (required.includes("dynamic_entity_behavior")) {
    const certified = new Set(evidence?.certifiedDynamicEntityIds ?? []);
    const dynamicEntities = gameSpec.entities.filter(
      (entity) => entity.behavior !== "static" && entity.behavior !== "none",
    );
    if (
      dynamicEntities.length > 0 &&
      dynamicEntities.every((entity) => certified.has(entity.id))
    ) {
      available.add("dynamic_entity_behavior");
    }
  }
  const supportedCapabilities = required.filter((capability) => available.has(capability));
  const unsupportedCapabilities = required.filter((capability) => !available.has(capability));
  const blockers = structuralBlockers(gameSpec, plan);
  const explicitlyRelatedFallback = gameSpec.flags.some((flag) => (
    flag === "deterministic_fallback" ||
    flag === "lane_a_fallback" ||
    flag === "p8_safety_recast" ||
    flag === "p8_guarded_floor" ||
    flag === "p8_reach_support" ||
    flag === "p8_optional_pickups" ||
    flag === "collect_all_fallback" ||
    flag === "survive_mode_fallback"
  ));
  const outcome: PlayContractOutcome = blockers.length > 0
    ? "needs_recast"
    : explicitlyRelatedFallback || unsupportedCapabilities.length > 0
      ? "related_fallback"
      : "faithful_ready";

  return {
    format: "inkling-play-contract-v1",
    runtimeVersion: "lane-a-runtime-v1",
    capabilityProfileVersion: "lane-a-capabilities-v1",
    templateId: capabilityProfile.templateId,
    declaredGenre: gameSpec.primary_genre,
    effectiveMovement: plan.contract.movement,
    goalKind: gameSpec.goal.kind,
    requiredInteractionEntityIds: [...plan.requiredCollectibleIds],
    requiredCapabilities: required,
    supportedCapabilities,
    unsupportedCapabilities,
    blockers,
    outcome,
  };
}
