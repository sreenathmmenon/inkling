import { P8_SYNTHETIC_ENTITY_PREFIX } from "../packages/runtime/src/synthetic-entity.js";
import { applyBoundedRepairs } from "../services/solve/src/playtest.js";
import type { BehaviorPatch, GameSpec, PlaytestReport } from "./types.js";

/**
 * The graded safety ladder P8 climbs when bounded model repairs cannot make
 * the interpreted world finishable. Rungs are ordered by how much of the
 * child's drawing stays playable; every rung is deterministic, reads only
 * roles/geometry/blocker evidence (never drawing nouns), and must be
 * certified by the deterministic playtester before P8 may approve it.
 */
export type RecastRung =
  | "bounded_adjustment"
  | "reach_support"
  | "pickup_relief"
  | "objective_fallback"
  | "guarded_floor"
  | "full_floor";

export const RECAST_RUNG_ORDER: readonly RecastRung[] = [
  "bounded_adjustment",
  "reach_support",
  "pickup_relief",
  "objective_fallback",
  "guarded_floor",
  "full_floor",
];

const SURFACE_ROLES = new Set(["platform", "water", "ice", "cloud", "launchpad", "mover"]);
const PICKUP_ROLES = new Set(["collectible", "key"]);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function uniqueEntityId(base: string, used: Set<string>): string {
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${base}_${suffix++}`;
  used.add(candidate);
  return candidate;
}

function addFlag(spec: GameSpec, flag: string): void {
  if (!spec.flags.includes(flag)) spec.flags.push(flag);
}

function addAssumption(spec: GameSpec, sentence: string): void {
  if (!spec.assumptions.includes(sentence)) spec.assumptions.push(sentence);
}

function blockerEntityId(report: PlaytestReport, prefix: string): string | undefined {
  const blocker = report.first_blocker ?? "";
  return blocker.startsWith(prefix) ? blocker.slice(prefix.length) : undefined;
}

function unreachedRequiredTargets(spec: GameSpec, report: PlaytestReport): GameSpec["entities"] {
  const visited = new Set(report.visited);
  // Only interactions that actually gate the declared goal are "required":
  // every pickup for collect_all, but for reach_goal only keys (which gate
  // physically at their doors) — bonus collectibles never block a win, so
  // they are never ladder targets.
  const gatingRoles = spec.goal.kind === "collect_all"
    ? PICKUP_ROLES
    : new Set(["key"]);
  const pickups = spec.entities.filter(
    (entity) => gatingRoles.has(entity.role) && !visited.has(entity.id),
  );
  if (pickups.length > 0) return pickups;
  const goalTarget = spec.entities.find(
    (entity) => entity.id === spec.goal.target_id && !visited.has(entity.id),
  );
  return goalTarget ? [goalTarget] : [];
}

/**
 * Rung 1 — keep everything; nudge only the single blocking element within
 * the same ±0.05 bounds the model's own repairs are held to.
 */
function boundedAdjustmentCandidate(
  source: GameSpec,
  report: PlaytestReport,
): GameSpec | null {
  const hazardId = blockerEntityId(report, "lives_exhausted:");
  if (hazardId) {
    const candidate = clone(source);
    const { applied } = applyBoundedRepairs(candidate, [
      { target_id: hazardId, op: "move", value: [0, 0.05] },
    ]);
    if (applied === 0) return null;
    addFlag(candidate, "p8_bounded_adjustment");
    addAssumption(candidate, "I nudged one tricky part a tiny bit so the game can be finished.");
    return candidate;
  }
  const wallId = blockerEntityId(report, "maze_topology_unreachable:");
  if (wallId) {
    const candidate = clone(source);
    const wall = candidate.entities.find((entity) => entity.id === wallId);
    if (!wall) return null;
    const [x1, y1, x2, y2] = wall.bbox;
    // Shorten the wall along its longer axis by the same 0.05 bound.
    if (x2 - x1 >= y2 - y1) wall.bbox = [x1, y1, Math.max(x1 + 0.01, x2 - 0.05), y2];
    else wall.bbox = [x1, y1, x2, Math.max(y1 + 0.01, y2 - 0.05)];
    addFlag(candidate, "p8_bounded_adjustment");
    addAssumption(candidate, "I opened one tiny gap so the maze can be finished.");
    return candidate;
  }
  return null;
}

/**
 * Rung 2 — everything keeps its role; one minimal one-way support platform is
 * added beneath the first unreached target so it becomes reachable. One-way
 * platforms cannot trap the hero, so this can only help.
 */
function reachSupportCandidate(
  source: GameSpec,
  report: PlaytestReport,
): GameSpec | null {
  const [target] = unreachedRequiredTargets(source, report);
  if (!target) return null;
  const candidate = clone(source);
  const used = new Set<string>([candidate.hero.id, ...candidate.entities.map((e) => e.id)]);
  const centerX = (target.bbox[0] + target.bbox[2]) / 2;
  const top = Math.min(0.94, target.bbox[3] + 0.05);
  candidate.entities.push({
    id: uniqueEntityId(`${P8_SYNTHETIC_ENTITY_PREFIX}support`, used),
    role: "platform",
    bbox: [
      Math.max(0.02, centerX - 0.07),
      top,
      Math.min(0.98, centerX + 0.07),
      Math.min(0.98, top + 0.04),
    ],
    behavior: "static",
    linked_to: null,
    style_ref: "synthetic-support",
  });
  addFlag(candidate, "p8_reach_support");
  addAssumption(candidate, "I added a little stepping platform so everything can be reached.");
  return candidate;
}

/**
 * Rung 3 — lower the required interactions: pickups the deterministic route
 * never reached stop being required and become part of the scenery. Pickups
 * the route did reach stay collectible; the drawn goal stays the goal.
 */
function pickupReliefCandidate(
  source: GameSpec,
  report: PlaytestReport,
): GameSpec | null {
  // Bonus collectibles never gate reach_goal, so there is nothing to
  // relieve there; relief exists for collect_all worlds whose declared
  // objective genuinely cannot be completed.
  if (source.goal.kind !== "collect_all") return null;
  const visited = new Set(report.visited);
  const unreached = source.entities.filter(
    (entity) => PICKUP_ROLES.has(entity.role) && !visited.has(entity.id),
  );
  if (unreached.length === 0) return null;
  const reachable = source.entities.filter(
    (entity) => PICKUP_ROLES.has(entity.role) && visited.has(entity.id),
  );
  // collect_all with nothing left to collect would hollow the goal out;
  // that simplification belongs to the objective rung instead.
  if (source.goal.kind === "collect_all" && reachable.length === 0) return null;
  const unreachedIds = new Set(unreached.map((entity) => entity.id));
  const candidate = clone(source);
  for (const entity of candidate.entities) {
    if (unreachedIds.has(entity.id)) {
      entity.role = "decoration";
      entity.behavior = "static";
      entity.linked_to = null;
    }
  }
  addFlag(candidate, "p8_optional_pickups");
  addAssumption(candidate, "Some treasures were too tricky to reach, so they are just part of the scenery now.");
  return candidate;
}

/** Rung 4 — the world is untouched; the objective becomes one it supports. */
function objectiveFallbackCandidate(source: GameSpec): GameSpec | null {
  const hasCollectibles = source.entities.some((entity) => entity.role === "collectible");
  const kind = hasCollectibles ? "collect_all" : "survive";
  if (source.goal.kind === kind) return null;
  const candidate = clone(source);
  candidate.goal = { kind, target_id: null };
  addFlag(candidate, hasCollectibles ? "collect_all_fallback" : "survive_mode_fallback");
  addAssumption(
    candidate,
    hasCollectibles
      ? "I made collecting everything the goal."
      : "I made staying safe for a little while the goal.",
  );
  return candidate;
}

function sanitizeDrawnEntityIds(candidate: GameSpec, used: Set<string>): void {
  // Model-provided ids are data, never trusted provenance: nothing drawn may
  // carry the reserved synthetic prefix Lane A uses for runner-created parts.
  for (const [index, entity] of candidate.entities.entries()) {
    if (entity.id.startsWith(P8_SYNTHETIC_ENTITY_PREFIX)) {
      entity.id = uniqueEntityId(`drawing_mark_${index + 1}`, used);
    } else {
      used.add(entity.id);
    }
  }
}

function appendSyntheticFloorAndFinish(candidate: GameSpec, used: Set<string>): void {
  const groundId = uniqueEntityId(`${P8_SYNTHETIC_ENTITY_PREFIX}ground`, used);
  const goalId = uniqueEntityId(`${P8_SYNTHETIC_ENTITY_PREFIX}finish`, used);
  const heroCenter = (candidate.hero.bbox[0] + candidate.hero.bbox[2]) / 2;
  const goalLeft = heroCenter <= 0.5 ? 0.82 : 0.06;
  candidate.entities.push(
    {
      id: groundId,
      role: "platform",
      bbox: [0.02, 0.9, 0.98, 0.96],
      behavior: "static",
      linked_to: null,
      style_ref: "synthetic-ground",
    },
    {
      id: goalId,
      role: "goal",
      bbox: [goalLeft, 0.7, goalLeft + 0.12, 0.9],
      behavior: "static",
      linked_to: null,
      style_ref: "synthetic-finish",
    },
  );
  candidate.goal = { kind: "reach_goal", target_id: goalId };
  candidate.primary_genre = "platformer";
  candidate.genre_confidence = 0;
  candidate.rules = { ...candidate.rules, difficulty_hint: "chill", modifiers: [] };
}

/**
 * Rung 5 — a guaranteed ground route and finish are added, but the child's
 * drawing stays part of the playable world wherever it cannot trap or hurt:
 * drawn surfaces remain landable one-way platforms and drawn pickups remain
 * collectible. Only roles that can block or damage become scenery.
 */
function guardedFloorCandidate(source: GameSpec): GameSpec {
  const candidate = clone(source);
  const used = new Set<string>([candidate.hero.id]);
  sanitizeDrawnEntityIds(candidate, used);
  for (const entity of candidate.entities) {
    if (SURFACE_ROLES.has(entity.role)) {
      entity.behavior = "static";
      entity.linked_to = null;
    } else if (PICKUP_ROLES.has(entity.role)) {
      entity.role = "collectible";
      entity.behavior = "static";
      entity.linked_to = null;
    } else {
      entity.role = "decoration";
      entity.behavior = "static";
      entity.linked_to = null;
    }
  }
  appendSyntheticFloorAndFinish(candidate, used);
  addFlag(candidate, "p8_guarded_floor");
  addAssumption(candidate, "I kept your drawing in the world and added a safe ground and finish line.");
  return candidate;
}

/**
 * Rung 6 — the deterministic Lane A floor that existed before the ladder:
 * every drawn mark is preserved as scenery at its drawn coordinates and the
 * mechanics are recast to a guaranteed ground route and finish.
 */
export function createDeterministicSafetyRecast(source: GameSpec): GameSpec {
  const used = new Set<string>([source.hero.id]);
  const decorations = source.entities.map((entity, index) => ({
    ...entity,
    id: uniqueEntityId(`drawing_mark_${index + 1}`, used),
    role: "decoration",
    behavior: "static",
    linked_to: null,
    bbox: [...entity.bbox] as GameSpec["entities"][number]["bbox"],
  }));
  const candidate: GameSpec = {
    ...source,
    hero: { ...source.hero, bbox: [...source.hero.bbox] },
    entities: decorations,
    goal: { ...source.goal },
    rules: { ...source.rules },
    palette: [...source.palette],
    assumptions: [
      ...source.assumptions,
      "Lane A recast the mechanics to its deterministic finishable floor after the solvability repair loop.",
    ],
    flags: [...new Set([...source.flags, "p8_safety_recast"])],
  };
  appendSyntheticFloorAndFinish(candidate, used);
  return candidate;
}

/**
 * Builds the candidate world for one rung, or null when the rung does not
 * apply to this world/blocker. Callers must certify the candidate with the
 * deterministic playtester before adopting it.
 */
export function buildRungCandidate(
  rung: RecastRung,
  source: GameSpec,
  report: PlaytestReport,
): GameSpec | null {
  switch (rung) {
    case "bounded_adjustment":
      return boundedAdjustmentCandidate(source, report);
    case "reach_support":
      return reachSupportCandidate(source, report);
    case "pickup_relief":
      return pickupReliefCandidate(source, report);
    case "objective_fallback":
      return objectiveFallbackCandidate(source);
    case "guarded_floor":
      return guardedFloorCandidate(source);
    case "full_floor":
      return createDeterministicSafetyRecast(source);
  }
}

/**
 * Behavior patches survive a rung only for entities whose id, role, and
 * behavior are unchanged in the adopted world; a demoted entity's patch (and
 * its static-fallback bookkeeping) is dropped with it.
 */
export function pruneBehaviorPatchesForWorld(
  patches: BehaviorPatch[],
  fallbacks: Record<string, "static">,
  before: GameSpec,
  after: GameSpec,
): {
  patches: BehaviorPatch[];
  fallbacks: Record<string, "static">;
  removedEntityIds: string[];
} {
  const beforeById = new Map(before.entities.map((entity) => [entity.id, entity]));
  const surviving = new Set(
    after.entities
      .filter((entity) => {
        const prior = beforeById.get(entity.id);
        return prior !== undefined && prior.role === entity.role && prior.behavior === entity.behavior;
      })
      .map((entity) => entity.id),
  );
  const keptPatches = patches.filter((patch) => surviving.has(patch.entityId));
  const keptFallbacks: Record<string, "static"> = {};
  for (const [entityId, value] of Object.entries(fallbacks)) {
    if (surviving.has(entityId)) keptFallbacks[entityId] = value;
  }
  const removedEntityIds = [
    ...patches.filter((patch) => !surviving.has(patch.entityId)).map((patch) => patch.entityId),
    ...Object.keys(fallbacks).filter((entityId) => !surviving.has(entityId)),
  ];
  return { patches: keptPatches, fallbacks: keptFallbacks, removedEntityIds: [...new Set(removedEntityIds)] };
}
