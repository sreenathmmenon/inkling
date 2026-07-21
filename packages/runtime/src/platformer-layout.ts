import type { GameSpec } from "../../../runner/types.js";
import { contractForGenre, type GameContract } from "./game-contract.js";
import {
  keyDoorRelationships,
  type KeyDoorRelationship,
} from "./relationship-contract.js";
import {
  MAZE_ROUTE_CLEARANCE_PADDING,
  mazeTopologyIsFinishable,
  mergeAdjacentWallStrips,
} from "./maze-topology.js";
import { WORLD_HEIGHT, WORLD_WIDTH } from "./world-geometry.js";
import { isP8SyntheticEntityId } from "./synthetic-entity.js";
import {
  TRACK_ANIMATABLE_ROLES,
  type BehaviorMotionTrack,
} from "./behavior-track.js";

export { WORLD_HEIGHT, WORLD_WIDTH } from "./world-geometry.js";

const PLATFORM_ROLES = new Set([
  "platform",
  "ice",
  "cloud",
  "launchpad",
]);
const HAZARD_ROLES = new Set(["hazard", "enemy", "boss"]);
const COLLECTIBLE_ROLES = new Set(["collectible", "key"]);

type BBox = [number, number, number, number];

export interface PlannedEntity {
  id: string;
  role: string;
  styleRef: string;
  artworkSource: "drawing" | "synthetic";
  x: number;
  y: number;
  width: number;
  height: number;
  /** Certified sandbox motion; present only for animatable dynamic roles. */
  track?: BehaviorMotionTrack;
}

export interface PlatformerPlan {
  title: string;
  primaryGenre: string;
  contract: GameContract;
  mood: string;
  palette: string[];
  lives: number;
  goalKind: string;
  modifiers: string[];
  hero: PlannedEntity;
  platforms: PlannedEntity[];
  doors: PlannedEntity[];
  waterVolumes: PlannedEntity[];
  hazards: PlannedEntity[];
  collectibles: PlannedEntity[];
  decorations: PlannedEntity[];
  requiredCollectibleIds: string[];
  /** Multiplier applied to hero horizontal speed by declared modifiers. */
  heroSpeedFactor: number;
  /** Declared modifiers the runtime could not apply; non-empty blocks faithfulness. */
  unappliedModifiers: string[];
  relationships: KeyDoorRelationship[];
  /**
   * Merged drawn wall geometry (sub-clearance seams sealed). The scene's
   * collision bodies, the topology check, and the analytic solver all read
   * these boxes, so the three can never disagree about clearance.
   */
  mazeCollisionWalls: PlannedEntity[];
  mazeTopologyFallback: boolean;
  goal: PlannedEntity;
  goalTrigger: PlannedEntity;
}

const FALLBACK_SPEC: GameSpec = {
  primary_genre: "platformer",
  genre_confidence: 0,
  mood: "playful",
  hero: {
    id: "hero_1",
    name: "Hero",
    bbox: [0.08, 0.68, 0.16, 0.82],
    style_ref: "source-drawing",
  },
  entities: [
    {
      id: "ground_1",
      role: "platform",
      bbox: [0.02, 0.82, 0.98, 0.88],
      behavior: "static",
      style_ref: "source-drawing",
    },
    {
      id: "goal_1",
      role: "goal",
      bbox: [0.86, 0.66, 0.94, 0.82],
      behavior: "static",
      style_ref: "source-drawing",
    },
  ],
  goal: { kind: "reach_goal", target_id: "goal_1" },
  rules: { lives: 3, difficulty_hint: "chill", modifiers: [] },
  palette: ["#fffaf0", "#263238", "#ffca58", "#5f9f45", "#d84343"],
  assumptions: ["Lane A used its deterministic playable fallback."],
  flags: ["lane_a_fallback"],
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validBBox(value: unknown): value is BBox {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))
  );
}

function normalizeBBox(value: unknown, fallback: BBox): BBox {
  if (!validBBox(value)) return fallback;
  const left = clamp(Math.min(value[0], value[2]), 0, 1);
  const right = clamp(Math.max(value[0], value[2]), 0, 1);
  const top = clamp(Math.min(value[1], value[3]), 0, 1);
  const bottom = clamp(Math.max(value[1], value[3]), 0, 1);
  if (right - left < 0.01 || bottom - top < 0.01) return fallback;
  return [left, top, right, bottom];
}

function asGameSpec(value: unknown): GameSpec {
  if (!isRecord(value) || !isRecord(value.hero) || !Array.isArray(value.entities)) {
    return structuredClone(FALLBACK_SPEC);
  }
  if (!isRecord(value.goal) || !isRecord(value.rules)) {
    return structuredClone(FALLBACK_SPEC);
  }
  if (
    typeof value.primary_genre !== "string" ||
    typeof value.hero.id !== "string" ||
    typeof value.hero.name !== "string" ||
    typeof value.hero.style_ref !== "string" ||
    !validBBox(value.hero.bbox)
  ) {
    return structuredClone(FALLBACK_SPEC);
  }
  return value as unknown as GameSpec;
}

function planned(
  id: string,
  role: string,
  styleRef: string,
  bbox: unknown,
  fallback: BBox,
  limits: { minWidth: number; minHeight: number; maxWidth: number; maxHeight: number },
  artworkSource: PlannedEntity["artworkSource"] = "drawing",
): PlannedEntity {
  const [left, top, right, bottom] = normalizeBBox(bbox, fallback);
  const width = clamp((right - left) * WORLD_WIDTH, limits.minWidth, limits.maxWidth);
  const height = clamp((bottom - top) * WORLD_HEIGHT, limits.minHeight, limits.maxHeight);
  return {
    id,
    role,
    styleRef,
    artworkSource,
    x: clamp(((left + right) / 2) * WORLD_WIDTH, width / 2, WORLD_WIDTH - width / 2),
    y: clamp(((top + bottom) / 2) * WORLD_HEIGHT, height / 2, WORLD_HEIGHT - height / 2),
    width,
    height,
  };
}

function surfaceTop(entity: PlannedEntity): number {
  return entity.y - entity.height / 2;
}

function chooseSupportSurface(
  entity: PlannedEntity,
  platforms: readonly PlannedEntity[],
): PlannedEntity | undefined {
  const candidates = platforms.filter(
    (platform) =>
      entity.x >= platform.x - platform.width / 2 &&
      entity.x <= platform.x + platform.width / 2,
  );
  const desiredBottom = entity.y + entity.height / 2;
  return candidates.sort(
    (left, right) =>
      Math.abs(surfaceTop(left) - desiredBottom) - Math.abs(surfaceTop(right) - desiredBottom),
  )[0];
}

function snapOntoSurface(
  entity: PlannedEntity,
  platforms: PlannedEntity[],
): PlannedEntity {
  const surface = chooseSupportSurface(entity, platforms);
  if (!surface) return entity;
  return { ...entity, y: surfaceTop(surface) - entity.height / 2 - 2 };
}

function safeSpawn(
  hero: PlannedEntity,
  hazards: PlannedEntity[],
): PlannedEntity {
  const overlapsHazard = (x: number, hazard: PlannedEntity): boolean => (
    Math.abs(x - hazard.x) * 2 < hero.width + hazard.width * 0.72 + 20 &&
    Math.abs(hero.y - hazard.y) * 2 < hero.height + hazard.height * 0.72 + 12
  );
  if (!hazards.some((hazard) => overlapsHazard(hero.x, hazard))) return hero;
  const candidates: number[] = [];
  for (let offset = 0; offset <= WORLD_WIDTH; offset += 24) {
    candidates.push(hero.x - offset, hero.x + offset);
  }
  const x = candidates
    .map((candidate) => clamp(candidate, hero.width / 2, WORLD_WIDTH - hero.width / 2))
    .find((candidate) => !hazards.some((hazard) => overlapsHazard(candidate, hazard)));
  return x === undefined ? hero : { ...hero, x };
}

function safeFreeSpawn(
  hero: PlannedEntity,
  hazards: PlannedEntity[],
  colliderScale: number,
): PlannedEntity {
  const collisionWidth = hero.width * colliderScale;
  const collisionHeight = hero.height * colliderScale;
  const overlapsHazard = (x: number, y: number, hazard: PlannedEntity): boolean => (
    Math.abs(x - hazard.x) * 2 < collisionWidth + hazard.width * 0.72 + 12 &&
    Math.abs(y - hazard.y) * 2 < collisionHeight + hazard.height * 0.72 + 12
  );
  if (!hazards.some((hazard) => overlapsHazard(hero.x, hero.y, hazard))) return hero;

  const candidates: Array<{ x: number; y: number; distance: number }> = [];
  for (let y = collisionHeight / 2; y <= WORLD_HEIGHT - collisionHeight / 2; y += 24) {
    for (let x = collisionWidth / 2; x <= WORLD_WIDTH - collisionWidth / 2; x += 24) {
      candidates.push({ x, y, distance: Math.hypot(x - hero.x, y - hero.y) });
    }
  }
  const safe = candidates
    .sort((left, right) => left.distance - right.distance || left.y - right.y || left.x - right.x)
    .find((candidate) => !hazards.some((hazard) => overlapsHazard(candidate.x, candidate.y, hazard)));
  return safe ? { ...hero, x: safe.x, y: safe.y } : hero;
}

function safePalette(value: unknown): string[] {
  if (!Array.isArray(value)) return [...FALLBACK_SPEC.palette];
  const colors = value.filter(
    (color): color is string => typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color),
  );
  return colors.length > 0 ? colors.slice(0, 8) : [...FALLBACK_SPEC.palette];
}

function contractForSpec(spec: GameSpec): GameContract {
  const declared = contractForGenre(spec.primary_genre);
  if (declared.movement !== "ground" && declared.movement !== "auto_ground") return declared;
  const [heroLeft, _heroTop, heroRight, heroBottom] = normalizeBBox(
    spec.hero.bbox,
    FALLBACK_SPEC.hero.bbox,
  );
  const heroX = (heroLeft + heroRight) / 2;
  // A runner's route is the drawn surface itself: any drawn surface keeps the
  // declared automatic movement, and plan creation relocates the spawn onto
  // the route start. Only a drawing with no surface at all downgrades —
  // trails and roads are legitimate support even when the hero is drawn
  // beside or inside the stroke rather than pixel-perfectly on top of it.
  const hasDrawnSupport = spec.entities.some((entity) => {
    if (!PLATFORM_ROLES.has(entity.role)) return false;
    const [left, top, right] = normalizeBBox(entity.bbox, [0, 0, 0, 0]);
    if (declared.movement === "auto_ground") return right - left >= 0.01;
    return heroX >= left && heroX <= right && top >= heroBottom - 0.1;
  });
  return hasDrawnSupport
    ? declared
    : {
      ...declared,
      movement: "free",
      colliderScale: 0.65,
      touchControls: "four_way",
      instruction: "Explore your world",
    };
}

/**
 * The only modifier vocabulary the runtime executes: the same bounded
 * encodings P8's repairs write. speed scales the hero's horizontal velocity
 * (applied identically by scene and solver); gap resizes the named platform
 * at plan level so both consume it by construction. Anything else is
 * recorded as unapplied and honestly blocks a faithful claim.
 */
function applyDeclaredModifiers(
  modifiers: string[],
  heroId: string,
  platforms: PlannedEntity[],
): { heroSpeedFactor: number; unapplied: string[] } {
  let heroSpeedFactor = 1;
  const unapplied: string[] = [];
  for (const raw of modifiers) {
    const parsed = raw.match(/^(speed|gap):([^:]+):(-?\d*\.?\d+)$/);
    const amount = parsed ? Number(parsed[3]) : Number.NaN;
    if (!parsed || !Number.isFinite(amount) || Math.abs(amount) > 0.05) {
      unapplied.push(raw);
      continue;
    }
    if (parsed[1] === "speed" && (parsed[2] === heroId || parsed[2] === "hero")) {
      heroSpeedFactor = clamp(heroSpeedFactor * (1 + amount * 4), 0.8, 1.2);
    } else if (parsed[1] === "gap") {
      const platform = platforms.find((candidate) => candidate.id === parsed[2]);
      if (!platform) {
        unapplied.push(raw);
        continue;
      }
      platform.width = clamp(platform.width + amount * WORLD_WIDTH, 24, WORLD_WIDTH);
    } else {
      unapplied.push(raw);
    }
  }
  return { heroSpeedFactor, unapplied };
}

function normalizedArea(value: unknown): number {
  const [left, top, right, bottom] = normalizeBBox(value, [0, 0, 0, 0]);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

/**
 * Converts normalized GameSpec geometry into a deterministic fixed-size physics plan.
 * Invalid or incomplete input falls back to a complete, playable platformer.
 */
export function createPlatformerPlan(
  input: unknown,
  behaviorTracks?: Record<string, BehaviorMotionTrack>,
): PlatformerPlan {
  const spec = asGameSpec(input);
  const modifiers = Array.isArray(spec.rules.modifiers) ? [...spec.rules.modifiers] : [];
  const contract = contractForSpec(spec);
  const safetyFloor: PlannedEntity = {
    id: "lane_a_safety_floor",
    role: "platform",
    styleRef: "lane-a-placeholder",
    artworkSource: "synthetic",
    x: WORLD_WIDTH / 2,
    y: WORLD_HEIGHT - 18,
    width: WORLD_WIDTH,
    height: 36,
  };

  const entities = spec.entities.filter(isRecord).map((entity, index) => ({
    id: typeof entity.id === "string" ? entity.id : `entity_${index + 1}`,
    role: typeof entity.role === "string" ? entity.role : "decoration",
    styleRef: typeof entity.style_ref === "string" ? entity.style_ref : "source-drawing",
    artworkSource: Array.isArray(spec.flags) && spec.flags.includes("p8_safety_recast") &&
      typeof entity.id === "string" && isP8SyntheticEntityId(entity.id)
      ? "synthetic" as const
      : "drawing" as const,
    bbox: entity.bbox,
  }));
  const relationships = keyDoorRelationships(spec);
  const platforms = entities
    .filter((entity) => PLATFORM_ROLES.has(entity.role))
    .map((entity) =>
      planned(entity.id, entity.role, entity.styleRef, entity.bbox, [0.1, 0.76, 0.9, 0.82], {
        minWidth: contract.id === "maze" ? 12 : 56,
        minHeight: contract.id === "maze" ? 12 : 16,
        maxWidth: WORLD_WIDTH,
        maxHeight: contract.id === "maze" ? WORLD_HEIGHT : 72,
      }, entity.artworkSource),
    );
  platforms.push(safetyFloor);
  const appliedModifiers = applyDeclaredModifiers(modifiers, spec.hero.id, platforms);

  const doors = entities
    .filter((entity) => entity.role === "door")
    .map((entity) => planned(entity.id, entity.role, entity.styleRef, entity.bbox, [0.66, 0.5, 0.72, 0.82], {
      minWidth: 36,
      minHeight: 64,
      maxWidth: 96,
      maxHeight: 220,
    }, entity.artworkSource));

  const waterVolumes = entities
    .filter((entity) => entity.role === "water")
    .map((entity) => planned(entity.id, entity.role, entity.styleRef, entity.bbox, [0.35, 0.65, 0.65, 0.9], {
      minWidth: 72,
      minHeight: 56,
      maxWidth: WORLD_WIDTH,
      maxHeight: WORLD_HEIGHT,
    }, entity.artworkSource));

  const rawHero = planned(
      spec.hero.id,
      "hero",
      spec.hero.style_ref,
      spec.hero.bbox,
      FALLBACK_SPEC.hero.bbox,
      contract.movement === "free"
        ? { minWidth: 64, minHeight: 84, maxWidth: 120, maxHeight: 160 }
        : { minWidth: 34, minHeight: 44, maxWidth: 64, maxHeight: 82 },
    );
  const usesFreeMovement = contract.movement === "free" || contract.movement === "launch";
  // An automatic runner starts at the beginning of its drawn route: when the
  // drawn hero is not over any drawn surface, relocate the spawn to the
  // leftmost drawn support deterministically. This keeps the declared
  // movement honest (the run happens on the child's trail, not the safety
  // floor) and the trace validator's drawn-support rule satisfiable.
  const drawnSupports = platforms.filter((platform) => platform.artworkSource === "drawing");
  const routeStart = [...drawnSupports].sort((left, right) =>
    (left.x - left.width / 2) - (right.x - right.width / 2))[0];
  // Whether the hero starts on drawn support is decided by the same
  // nearest-surface rule the snap applies — never by x-overlap alone. A
  // drawn hero whose x crosses a strip can still snap to the synthetic
  // safety floor, and a few pixels of extraction jitter in the hero bbox
  // must not flip the run between the child's trail and the floor. If the
  // hero would not start on drawn support, it starts on the drawn route:
  // over a strip, drop onto that strip; otherwise relocate to the leftmost
  // strip's left edge. Deterministic, geometry-only, and P8 still certifies
  // the resulting route.
  let routeStartHero = rawHero;
  if (contract.movement === "auto_ground" && routeStart) {
    const support = chooseSupportSurface(rawHero, platforms);
    if (support?.artworkSource !== "drawing") {
      const drawnBelow = chooseSupportSurface(rawHero, drawnSupports);
      const target = drawnBelow ?? routeStart;
      routeStartHero = {
        ...rawHero,
        x: drawnBelow
          ? rawHero.x
          : clamp(
            routeStart.x - routeStart.width / 2 + rawHero.width / 2,
            rawHero.width / 2,
            WORLD_WIDTH - rawHero.width / 2,
          ),
        y: surfaceTop(target) - rawHero.height / 2 - 2,
      };
    }
  }
  const surfaceHero = usesFreeMovement ? routeStartHero : snapOntoSurface(routeStartHero, platforms);

  const targetId = spec.goal.target_id ?? entities.find((entity) => entity.role === "goal")?.id;
  const target = entities.find((entity) => entity.id === targetId) ?? {
    id: "lane_a_goal",
    role: "goal",
    styleRef: "lane-a-placeholder",
    artworkSource: "synthetic" as const,
    bbox: [0.86, 0.66, 0.94, 0.82] as BBox,
  };
  const rawGoal = planned(target.id, "goal", target.styleRef, target.bbox, [0.86, 0.66, 0.94, 0.82], {
      minWidth: 38,
      minHeight: 54,
      maxWidth: 72,
      maxHeight: 96,
    }, target.artworkSource);
  const goal = usesFreeMovement ? rawGoal : snapOntoSurface(rawGoal, platforms);

  const hazards = entities
    .filter(
      (entity) =>
        HAZARD_ROLES.has(entity.role) &&
        // World-sized zones are environmental art, not discrete collision
        // bodies. A localized region remains hazardous; a page-wide region
        // would otherwise make any deterministic template impossible.
        normalizedArea(entity.bbox) < 0.24 &&
        !(spec.goal.kind === "defeat_boss" && entity.id === target.id),
    )
    .map((entity) => {
      const hazard = planned(entity.id, entity.role, entity.styleRef, entity.bbox, [0.45, 0.7, 0.55, 0.82], {
          minWidth: 32,
          minHeight: 28,
          maxWidth: 88,
          maxHeight: 64,
        }, entity.artworkSource);
      const settled = usesFreeMovement ? hazard : snapOntoSurface(hazard, platforms);
      // Certified motion applies only to animatable roles, only for drawn
      // entities, and only when the track's id matches — anything else moves
      // nothing and stays exactly as deterministic as before.
      const track = behaviorTracks?.[settled.id];
      if (
        track &&
        track.entityId === settled.id &&
        TRACK_ANIMATABLE_ROLES.has(settled.role) &&
        settled.artworkSource === "drawing"
      ) {
        return { ...settled, track };
      }
      return settled;
    });
  const hero = usesFreeMovement
    ? safeFreeSpawn(surfaceHero, hazards, contract.colliderScale)
    : safeSpawn(surfaceHero, hazards);
  const collectibles = entities
    .filter((entity) => COLLECTIBLE_ROLES.has(entity.role))
    .map((entity) => {
      const collectible = planned(entity.id, entity.role, entity.styleRef, entity.bbox, [0.45, 0.64, 0.5, 0.72], {
        minWidth: 24,
        minHeight: 24,
        maxWidth: 42,
        maxHeight: 42,
        }, entity.artworkSource);
      return usesFreeMovement ? collectible : snapOntoSurface(collectible, platforms);
    });
  const decorations = entities
    .filter((entity) => entity.role === "decoration")
    .map((entity) => planned(entity.id, entity.role, entity.styleRef, entity.bbox, [0.4, 0.15, 0.6, 0.35], {
      minWidth: 18,
      minHeight: 18,
      maxWidth: 260,
      maxHeight: 220,
    }, entity.artworkSource));
  // A collect-all game with no collectible entities has no possible progress
  // event in either Phaser or P8. Keep the same generated world and fall back
  // to its deterministic finish marker rather than creating a dead end.
  const goalKind = spec.goal.kind === "collect_all" && collectibles.length === 0
    ? "reach_goal"
    : spec.goal.kind || "reach_goal";
  // reach_goal means reach the goal: drawn collectibles are bonus, never
  // gating. Only collect_all makes gathering the objective, and only drawn
  // key->door relationships gate progress (physically, at the door). One
  // gem scribbled into an unreachable corner must never make a level
  // unwinnable — the schema keeps the two goal kinds distinct on purpose.
  const relationshipKeyIds = relationships.map((relationship) => relationship.keyId);
  const requiredCollectibleIds = goalKind === "collect_all"
    ? collectibles.map((collectible) => collectible.id)
    : relationshipKeyIds;

  const goalTrigger: PlannedEntity = usesFreeMovement
    ? {
      ...goal,
      id: `${goal.id}_trigger`,
      styleRef: "lane-a-goal-trigger",
      artworkSource: "synthetic",
      width: Math.max(64, goal.width),
      height: Math.max(64, goal.height),
    }
    : {
      ...goal,
      id: `${goal.id}_trigger`,
      styleRef: "lane-a-goal-trigger",
      artworkSource: "synthetic",
      width: Math.max(64, goal.width + 20),
      height: Math.max(64, goal.height + 20),
    };

  const drawnMazeWalls = platforms.filter((platform) => platform.id !== safetyFloor.id);
  // Children regularly draw the maze-runner larger than the corridors, and the
  // drawing sets the maze's scale. The hero's planned size therefore shrinks in
  // fixed deterministic steps until the drawn topology admits a route; a maze
  // that no reasonable size can finish is honestly sealed. Geometry-only: no
  // drawing subject, filename, or model verdict participates.
  const mazeHeroCandidates = [1, 0.85, 0.72, 0.6, 0.5].map((scale) => (scale === 1 ? hero : {
    ...hero,
    width: Math.max(34, Math.round(hero.width * scale)),
    height: Math.max(34, Math.round(hero.height * scale)),
  }));
  // Extraction fragments one drawn wall into several strips, and the exact
  // seams flutter run to run. Seams below the smallest candidate hero's
  // clearance are sealed before any topology, collision, or solver decision
  // reads the walls, so equivalent extractions converge to equivalent
  // topology while every genuinely passable corridor stays open.
  const smallestMazeHero = mazeHeroCandidates[mazeHeroCandidates.length - 1] ?? hero;
  const sealableGapBelow =
    Math.min(smallestMazeHero.width, smallestMazeHero.height) * contract.colliderScale +
    MAZE_ROUTE_CLEARANCE_PADDING;
  const mazeWalls = contract.id === "maze"
    ? mergeAdjacentWallStrips(drawnMazeWalls, sealableGapBelow)
    : drawnMazeWalls;
  const fittedMazeHero = contract.id === "maze"
    ? mazeHeroCandidates.find((candidate) => mazeTopologyIsFinishable({
      hero: candidate,
      goal,
      walls: mazeWalls,
      doors,
      hazards,
      collectibles,
      requiredCollectibleIds: [...new Set(requiredCollectibleIds)],
      relationships,
      collectAll: goalKind === "collect_all",
      colliderScale: contract.colliderScale,
    }))
    : hero;
  const mazeTopologyFallback = contract.id === "maze" && fittedMazeHero === undefined;

  return {
    title: spec.hero.name,
    primaryGenre: spec.primary_genre,
    contract,
    mood: spec.mood ?? "playful",
    palette: safePalette(spec.palette),
    lives: clamp(Math.round(spec.rules.lives || 3), 1, 9),
    goalKind,
    modifiers,
    hero: fittedMazeHero ?? hero,
    platforms,
    doors,
    waterVolumes,
    hazards,
    collectibles,
    decorations,
    requiredCollectibleIds: [...new Set(requiredCollectibleIds)],
    heroSpeedFactor: appliedModifiers.heroSpeedFactor,
    unappliedModifiers: appliedModifiers.unapplied,
    relationships,
    mazeCollisionWalls: contract.id === "maze" && !mazeTopologyFallback ? mazeWalls : [],
    mazeTopologyFallback,
    goal,
    goalTrigger,
  };
}
