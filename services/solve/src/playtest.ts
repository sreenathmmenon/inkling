import {
  createPlatformerPlan,
  type PlannedEntity,
} from "../../../packages/runtime/src/platformer-layout.js";
import { PLATFORMER_PHYSICS } from "../../../packages/runtime/src/platformer-physics.js";
import {
  surfaceJumpVelocity,
  surfaceVelocityX,
} from "../../../packages/runtime/src/platformer-materials.js";
import {
  emptyInputFrame,
  type InputFrame,
} from "../../../packages/runtime/src/input-frame.js";
import type { GameSpec, PlaytestReport } from "../../../runner/types.js";

const DEFAULT_SEED = 0x1a2b3c4d;

interface SimulatedBody {
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
}

interface SimulatedProjectile extends SimulatedBody {
  remainingSeconds: number;
}

function overlaps(
  body: SimulatedBody,
  width: number,
  height: number,
  entity: PlannedEntity,
): boolean {
  return (
    Math.abs(body.x - entity.x) * 2 < width + entity.width &&
    Math.abs(body.y - entity.y) * 2 < height + entity.height
  );
}

function platformTop(entity: PlannedEntity): number {
  return entity.y - entity.height / 2;
}

function overlapsHazard(
  body: SimulatedBody,
  heroWidth: number,
  heroHeight: number,
  hazard: PlannedEntity,
): boolean {
  return overlaps(body, heroWidth, heroHeight, {
    ...hazard,
    width: hazard.width * 0.72,
    height: hazard.height * 0.72,
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function nearestOutstanding(
  body: SimulatedBody,
  collectibles: PlannedEntity[],
  collected: Set<string>,
): PlannedEntity | undefined {
  return collectibles
    .filter((item) => !collected.has(item.id))
    .sort((left, right) => {
      const leftDistance = Math.hypot(left.x - body.x, left.y - body.y);
      const rightDistance = Math.hypot(right.x - body.x, right.y - body.y);
      return leftDistance - rightDistance || left.id.localeCompare(right.id);
    })[0];
}

function lowestOutstanding(
  body: SimulatedBody,
  collectibles: PlannedEntity[],
  collected: Set<string>,
): PlannedEntity | undefined {
  return collectibles
    .filter((item) => !collected.has(item.id))
    .sort((left, right) => {
      // Ground games are most reliably traversed bottom-up. This prevents the
      // solver from skipping onto a higher landing surface while chasing a
      // nearby mid-level item, then repeatedly descending for what it missed.
      const verticalOrder = right.y - left.y;
      if (Math.abs(verticalOrder) > 12) return verticalOrder;
      const leftDistance = Math.hypot(left.x - body.x, left.y - body.y);
      const rightDistance = Math.hypot(right.x - body.x, right.y - body.y);
      return leftDistance - rightDistance || left.id.localeCompare(right.id);
    })[0];
}

interface RoutePoint {
  x: number;
  y: number;
}

/**
 * Finds a deterministic four-way route for a capable free-movement player.
 * Hazards are expanded by the hero body, so the route tests the same overlap
 * rule as Phaser instead of approving paths that merely look clear at a point.
 */
function routeAroundHazards(
  start: RoutePoint,
  target: RoutePoint,
  heroWidth: number,
  heroHeight: number,
  hazards: PlannedEntity[],
): RoutePoint[] {
  const cellSize = 30;
  const columns = Math.ceil(960 / cellSize);
  const rows = Math.ceil(540 / cellSize);
  const cellIndex = (column: number, row: number): number => row * columns + column;
  const coordinates = (index: number): [number, number] => [index % columns, Math.floor(index / columns)];
  const columnFor = (x: number): number => clamp(Math.floor(x / cellSize), 0, columns - 1);
  const rowFor = (y: number): number => clamp(Math.floor(y / cellSize), 0, rows - 1);
  const centre = (column: number, row: number): RoutePoint => ({
    x: clamp(column * cellSize + cellSize / 2, heroWidth / 2, 960 - heroWidth / 2),
    y: clamp(row * cellSize + cellSize / 2, heroHeight / 2, 540 - heroHeight / 2),
  });
  const startIndex = cellIndex(columnFor(start.x), rowFor(start.y));
  const targetIndex = cellIndex(columnFor(target.x), rowFor(target.y));
  const blocked = (column: number, row: number): boolean => {
    const point = centre(column, row);
    return hazards.some((hazard) => overlaps(
      { ...point, velocityX: 0, velocityY: 0 },
      heroWidth + 12,
      heroHeight + 12,
      hazard,
    ));
  };

  const parent = new Int32Array(columns * rows);
  parent.fill(-2);
  parent[startIndex] = -1;
  const queue = [startIndex];
  const directions: ReadonlyArray<readonly [number, number]> = [
    [1, 0], [0, 1], [-1, 0], [0, -1],
  ];
  for (let cursor = 0; cursor < queue.length && parent[targetIndex] === -2; cursor += 1) {
    const current = queue[cursor]!;
    const [column, row] = coordinates(current);
    for (const [dx, dy] of directions) {
      const nextColumn = column + dx;
      const nextRow = row + dy;
      if (nextColumn < 0 || nextRow < 0 || nextColumn >= columns || nextRow >= rows) continue;
      const next = cellIndex(nextColumn, nextRow);
      if (parent[next] !== -2) continue;
      if (next !== targetIndex && blocked(nextColumn, nextRow)) continue;
      parent[next] = current;
      queue.push(next);
    }
  }
  if (parent[targetIndex] === -2) return [target];

  const reversed: RoutePoint[] = [];
  for (let index = targetIndex; index !== startIndex; index = parent[index]!) {
    const [column, row] = coordinates(index);
    reversed.push(centre(column, row));
  }
  reversed.reverse();
  reversed.push(target);
  return reversed;
}

/**
 * Deterministic player-equivalent Lane A simulation. It shares the exact
 * platformer plan, world bounds, gravity, movement, jump, hazards, lives,
 * collectibles, goal trigger, and survival timer used by the Phaser player.
 * It deliberately has no wall-clock, network, or model dependency.
 */
function executePlaytest(
  gameSpec: GameSpec,
  seed: number,
  inputFrames?: InputFrame[],
): PlaytestReport {
  const plan = createPlatformerPlan(gameSpec);
  const dt = PLATFORMER_PHYSICS.fixedStepSeconds;
  const maxFrames = Math.round(PLATFORMER_PHYSICS.maxPlaytestSeconds / dt);
  const usesFreeMovement = plan.contract.movement === "free" || plan.contract.movement === "launch";
  const heroWidth = usesFreeMovement
    ? plan.hero.width * PLATFORMER_PHYSICS.freeMovementColliderScale
    : plan.hero.width;
  const heroHeight = usesFreeMovement
    ? plan.hero.height * PLATFORMER_PHYSICS.freeMovementColliderScale
    : plan.hero.height;
  const body: SimulatedBody = {
    x: plan.hero.x,
    y: plan.hero.y,
    velocityX: 0,
    velocityY: 0,
  };
  const visited = new Set<string>([plan.hero.id]);
  const collected = new Set<string>();
  let lives = plan.lives;
  let grounded = false;
  let groundedPlatform: PlannedEntity | undefined;
  let descendingFrom: PlannedEntity | undefined;
  let descentExitX = 0;
  let invulnerableUntil = 0;
  let surviveRemainingMs = PLATFORMER_PHYSICS.surviveDurationMs;
  let lastProjectileAt = -Infinity;
  const projectiles: SimulatedProjectile[] = [];
  let freeRouteTargetId = "";
  let freeRoute: RoutePoint[] = [];
  let freeRouteIndex = 0;

  const respawn = (): void => {
    body.x = plan.hero.x;
    body.y = plan.hero.y;
    body.velocityX = 0;
    body.velocityY = 0;
    grounded = false;
    groundedPlatform = undefined;
    descendingFrom = undefined;
  };

  for (let frame = 0; frame < maxFrames; frame += 1) {
    const elapsedMs = frame * dt * 1_000;
    const input = emptyInputFrame(frame + 1);
    let inputRecorded = false;
    const recordInput = (): void => {
      if (inputRecorded) return;
      inputFrames?.push(input);
      inputRecorded = true;
    };
    if (
      plan.contract.action === "projectile" &&
      plan.goalKind === "defeat_boss" &&
      elapsedMs - lastProjectileAt >= PLATFORMER_PHYSICS.projectileCooldownMs
    ) {
      input.action = true;
      const dx = plan.goal.x - body.x;
      const dy = plan.goal.y - body.y;
      const magnitude = Math.max(1, Math.hypot(dx, dy));
      projectiles.push({
        x: body.x,
        y: body.y,
        velocityX: (dx / magnitude) * PLATFORMER_PHYSICS.projectileVelocity,
        velocityY: (dy / magnitude) * PLATFORMER_PHYSICS.projectileVelocity,
        remainingSeconds: PLATFORMER_PHYSICS.projectileLifetimeMs / 1_000,
      });
      lastProjectileAt = elapsedMs;
    }
    if (usesFreeMovement) {
      // Mirrors the free-movement scene: no gravity, bounded movement, and the
      // same fixed horizontal/vertical speed. The policy heads to outstanding
      // collectibles before the final target so collect-all games are tested
      // against their actual control contract.
      const target = plan.goalKind === "survive"
        ? undefined
        : plan.goalKind === "collect_all"
          ? nearestOutstanding(body, plan.collectibles, collected) ?? plan.goal
          : plan.goal;
      if (target && target.id !== freeRouteTargetId) {
        freeRouteTargetId = target.id;
        freeRoute = routeAroundHazards(body, target, heroWidth, heroHeight, plan.hazards);
        freeRouteIndex = 0;
      }
      let waypoint = freeRoute[freeRouteIndex];
      while (waypoint && Math.hypot(waypoint.x - body.x, waypoint.y - body.y) < 12) {
        freeRouteIndex += 1;
        waypoint = freeRoute[freeRouteIndex];
      }
      const destination = waypoint ?? target;
      body.velocityX = destination
        ? Math.sign(destination.x - body.x) * PLATFORMER_PHYSICS.moveVelocityX
        : 0;
      body.velocityY = destination
        ? Math.sign(destination.y - body.y) * PLATFORMER_PHYSICS.moveVelocityX
        : 0;
      input.left = body.velocityX < 0;
      input.right = body.velocityX > 0;
      input.jump = body.velocityY < 0;
      input.down = body.velocityY > 0;
      body.x = clamp(body.x + body.velocityX * dt, heroWidth / 2, 960 - heroWidth / 2);
      body.y = clamp(body.y + body.velocityY * dt, heroHeight / 2, 540 - heroHeight / 2);
    } else {
      // This deterministic policy is deliberately simple and reproducible:
      // move toward the goal direction and jump whenever the player has landed.
      const triggerTop = plan.goalTrigger.y - plan.goalTrigger.height / 2;
      const triggerBottom = plan.goalTrigger.y + plan.goalTrigger.height / 2;
      const triggerRouteTarget = {
        ...plan.goalTrigger,
        y: clamp(body.y, triggerTop, triggerBottom),
      };
      const routeTarget = plan.goalKind === "collect_all"
        ? lowestOutstanding(body, plan.collectibles, collected) ?? triggerRouteTarget
        : plan.requiredCollectibleIds.some((id) => !collected.has(id))
          ? lowestOutstanding(
            body,
            plan.collectibles.filter((item) => plan.requiredCollectibleIds.includes(item.id)),
            collected,
          ) ?? triggerRouteTarget
        : plan.goalKind === "reach_goal"
          // A ground player only needs to enter the trigger's horizontal
          // span. Chasing its visual centre can make the solver climb onto
          // decorative platforms even though the same Phaser trigger already
          // extends down to the playable floor.
          ? triggerRouteTarget
          : plan.goal;
      const targetIsBelow = Boolean(
        groundedPlatform &&
        routeTarget.y > body.y + heroHeight / 2 + 12,
      );
      let targetX = routeTarget.x;
      if (targetIsBelow && groundedPlatform) {
        const leftExit = groundedPlatform.x - groundedPlatform.width / 2 - heroWidth / 2 - 4;
        const rightExit = groundedPlatform.x + groundedPlatform.width / 2 + heroWidth / 2 + 4;
        descentExitX = Math.abs(routeTarget.x - leftExit) <= Math.abs(routeTarget.x - rightExit)
          ? leftExit
          : rightExit;
        descendingFrom = groundedPlatform;
      }
      if (
        descendingFrom &&
        body.y - heroHeight / 2 > descendingFrom.y + descendingFrom.height / 2 + 4
      ) {
        descendingFrom = undefined;
      }
      if (descendingFrom) targetX = descentExitX;
      const direction = Math.sign(targetX - body.x);
      input.left = direction < 0;
      input.right = direction > 0;
      const inWater = plan.waterVolumes.some((water) => overlaps(
        body,
        heroWidth * 0.7,
        heroHeight * 0.7,
        water,
      ));
      body.velocityX = inWater
        ? direction * PLATFORMER_PHYSICS.waterMoveVelocityX
        : surfaceVelocityX(body.velocityX, direction as -1 | 0 | 1, groundedPlatform?.role);
      const hazardAhead = plan.hazards.some((hazard) => {
        const distance = (hazard.x - body.x) * (direction || 1);
        const hazardHalfHeight = hazard.height * 0.36;
        const hazardTop = hazard.y - hazardHalfHeight;
        const hazardBottom = hazard.y + hazardHalfHeight;
        const heroTop = body.y - heroHeight / 2;
        const heroBottom = body.y + heroHeight / 2;
        return distance >= 0 && distance < heroWidth / 2 + hazard.width * 0.36 + 56 &&
          hazardBottom >= heroTop - 8 && hazardTop <= heroBottom + 120;
      });
      const targetIsAbove = routeTarget.y < body.y - heroHeight * 0.35;
      if (
        (grounded || (inWater && frame % 20 === 0)) &&
        !targetIsBelow &&
        !descendingFrom &&
        (targetIsAbove || hazardAhead)
      ) {
        input.jump = true;
        body.velocityY = inWater
          ? PLATFORMER_PHYSICS.waterJumpVelocityY
          : surfaceJumpVelocity(groundedPlatform?.role);
        grounded = false;
        groundedPlatform = undefined;
      }

      const previousBottom = body.y + heroHeight / 2;
      body.velocityY = clamp(
        body.velocityY + (inWater ? PLATFORMER_PHYSICS.waterGravityY : PLATFORMER_PHYSICS.gravityY) * dt,
        -PLATFORMER_PHYSICS.maxVelocityY,
        PLATFORMER_PHYSICS.maxVelocityY,
      );
      const previousX = body.x;
      body.x = clamp(
        body.x + body.velocityX * dt,
        heroWidth / 2,
        960 - heroWidth / 2,
      );
      body.y += body.velocityY * dt;
      const lockedDoor = plan.doors.find((door) => {
        const relationship = plan.relationships.find((item) => item.doorId === door.id);
        const unlocked = relationship ? collected.has(relationship.keyId) : false;
        return !unlocked && overlaps(body, heroWidth, heroHeight, door);
      });
      if (lockedDoor) {
        body.x = previousX;
        body.velocityX = 0;
        visited.add(lockedDoor.id);
      }
      grounded = false;
      groundedPlatform = undefined;

      if (body.velocityY >= 0) {
        const currentBottom = body.y + heroHeight / 2;
        const landing = plan.platforms
          .filter((platform) =>
            overlaps(body, heroWidth, heroHeight, platform) &&
            previousBottom <= platformTop(platform) + 2 &&
            currentBottom >= platformTop(platform),
          )
          .sort((left, right) => platformTop(left) - platformTop(right))[0];
        if (landing) {
          body.y = platformTop(landing) - heroHeight / 2 - 2;
          body.velocityY = 0;
          grounded = true;
          groundedPlatform = landing;
          if (descendingFrom && landing.id !== descendingFrom.id) {
            descendingFrom = undefined;
          }
          visited.add(landing.id);
        }
      }
      if (body.y > 540 + heroHeight) {
        recordInput();
        lives -= 1;
        if (lives <= 0) {
          return {
            reached_goal: false,
            first_blocker: "fell_out_of_world",
            time_to_win: null,
            seed,
            visited: [...visited],
          };
        }
        respawn();
        continue;
      }
    }

    recordInput();

    if (elapsedMs >= invulnerableUntil) {
      const hazard = plan.hazards.find((item) => overlapsHazard(body, heroWidth, heroHeight, item));
      if (hazard) {
        visited.add(hazard.id);
        lives -= 1;
        if (lives <= 0) {
          return {
            reached_goal: false,
            first_blocker: `lives_exhausted:${hazard.id}`,
            time_to_win: null,
            seed,
            visited: [...visited],
          };
        }
        invulnerableUntil = elapsedMs + PLATFORMER_PHYSICS.invulnerabilityMs;
        respawn();
        continue;
      }
    }

    for (const collectible of plan.collectibles) {
      if (!collected.has(collectible.id) && overlaps(body, heroWidth, heroHeight, collectible)) {
        collected.add(collectible.id);
        visited.add(collectible.id);
      }
    }

    for (let index = projectiles.length - 1; index >= 0; index -= 1) {
      const projectile = projectiles[index]!;
      projectile.x += projectile.velocityX * dt;
      projectile.y += projectile.velocityY * dt;
      projectile.remainingSeconds -= dt;
      if (overlaps(projectile, 14, 14, plan.goal)) {
        visited.add(plan.goal.id);
        return {
          reached_goal: true,
          first_blocker: null,
          time_to_win: Number((elapsedMs / 1_000).toFixed(2)),
          seed,
          visited: [...visited],
        };
      }
      if (projectile.remainingSeconds <= 0) projectiles.splice(index, 1);
    }

    // The Phaser player wins immediately on the final collectible. Do not
    // require a synthetic fallback goal after that—P8 must simulate the same
    // finish condition the child actually sees.
    if (plan.goalKind === "collect_all" && collected.size >= plan.collectibles.length) {
      return {
        reached_goal: true,
        first_blocker: null,
        time_to_win: Number((elapsedMs / 1_000).toFixed(2)),
        seed,
        visited: [...visited],
      };
    }

    if (plan.goalKind === "survive") {
      surviveRemainingMs -= dt * 1_000;
      if (surviveRemainingMs <= 0) {
        return {
          reached_goal: true,
          first_blocker: null,
          time_to_win: Number((elapsedMs / 1_000).toFixed(2)),
          seed,
          visited: [...visited],
        };
      }
      continue;
    }
    if (plan.goalKind === "defeat_boss") {
      if (plan.contract.action !== "projectile" && overlaps(body, heroWidth, heroHeight, plan.goal)) {
        visited.add(plan.goal.id);
        return {
          reached_goal: true,
          first_blocker: null,
          time_to_win: Number((elapsedMs / 1_000).toFixed(2)),
          seed,
          visited: [...visited],
        };
      }
      continue;
    }
    if (
      (plan.goalKind !== "collect_all" || collected.size >= plan.collectibles.length) &&
      plan.requiredCollectibleIds.every((id) => collected.has(id)) &&
      overlaps(body, heroWidth, heroHeight, plan.goalTrigger)
    ) {
      visited.add(plan.goal.id);
      return {
        reached_goal: true,
        first_blocker: null,
        time_to_win: Number((elapsedMs / 1_000).toFixed(2)),
        seed,
        visited: [...visited],
      };
    }
  }

  const blocker = plan.goalKind === "collect_all" && collected.size < plan.collectibles.length
    ? "collectibles_not_reached"
    : "playtest_timeout";
  return {
    reached_goal: false,
    first_blocker: blocker,
    time_to_win: null,
    seed,
    visited: [...visited],
  };
}

export function runPlaytest(
  gameSpec: GameSpec,
  seed = DEFAULT_SEED,
): PlaytestReport {
  return executePlaytest(gameSpec, seed);
}

export interface PlaytestTraceResult {
  report: PlaytestReport;
  inputFrames: InputFrame[];
}

/** Produces the deterministic policy trace that must be replayed by Phaser. */
export function runPlaytestWithTrace(
  gameSpec: GameSpec,
  seed = DEFAULT_SEED,
): PlaytestTraceResult {
  const inputFrames: InputFrame[] = [];
  return { report: executePlaytest(gameSpec, seed, inputFrames), inputFrames };
}

interface Repair {
  target_id: string;
  op: "move" | "speed" | "gap" | "lives";
  value: number[];
}

function finiteNumbers(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(Number.isFinite);
}

export function applyBoundedRepairs(
  gameSpec: GameSpec,
  repairs: unknown,
): { applied: number; rejected: string[] } {
  const rejected: string[] = [];
  let applied = 0;
  if (!Array.isArray(repairs)) return { applied, rejected: ["repairs_not_array"] };

  for (const candidate of repairs) {
    const repair = candidate as Partial<Repair>;
    if (
      typeof repair.target_id !== "string" ||
      !repair.op ||
      !finiteNumbers(repair.value)
    ) {
      rejected.push("invalid_repair_shape");
      continue;
    }
    if (repair.op === "move") {
      if (
        repair.value.length !== 2 ||
        repair.value.some((amount) => Math.abs(amount) > 0.05)
      ) {
        rejected.push(`${repair.target_id}:move_out_of_bounds`);
        continue;
      }
      const entity = gameSpec.entities.find((item) => item.id === repair.target_id);
      if (!entity) {
        rejected.push(`${repair.target_id}:unknown_target`);
        continue;
      }
      const [dx, dy] = repair.value;
      if (dx === undefined || dy === undefined) continue;
      entity.bbox = entity.bbox.map((coordinate, index) =>
        Math.max(0, Math.min(1, coordinate + (index % 2 === 0 ? dx : dy))),
      ) as [number, number, number, number];
      applied += 1;
      continue;
    }
    if (repair.op === "lives") {
      const lives = repair.value[0];
      if (!Number.isInteger(lives) || lives === undefined || lives < 1 || lives > 9) {
        rejected.push(`${repair.target_id}:lives_out_of_bounds`);
        continue;
      }
      gameSpec.rules.lives = lives;
      applied += 1;
      continue;
    }
    const amount = repair.value[0];
    if (amount === undefined || Math.abs(amount) > 0.05) {
      rejected.push(`${repair.target_id}:${repair.op}_out_of_bounds`);
      continue;
    }
    const modifiers = (gameSpec.rules.modifiers ??= []);
    const prefix = `${repair.op}:${repair.target_id}:`;
    const existing = modifiers.findIndex((item) => item.startsWith(prefix));
    const encoded = `${prefix}${amount}`;
    if (existing >= 0) modifiers[existing] = encoded;
    else modifiers.push(encoded);
    applied += 1;
  }
  return { applied, rejected };
}
