import type { KeyDoorRelationship } from "./relationship-contract.js";
import type { PlannedEntity } from "./platformer-layout.js";
import { WORLD_HEIGHT, WORLD_WIDTH } from "./world-geometry.js";

export interface MazePoint {
  x: number;
  y: number;
}

/**
 * The padding the four-way route search adds around the hero body when it
 * tests a cell against walls. Every clearance decision — route search, the
 * direct-line maze check, and wall-strip merging — must share this value.
 */
export const MAZE_ROUTE_CLEARANCE_PADDING = 8;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function overlaps(point: MazePoint, width: number, height: number, entity: PlannedEntity): boolean {
  return Math.abs(point.x - entity.x) * 2 < width + entity.width &&
    Math.abs(point.y - entity.y) * 2 < height + entity.height;
}

/** Four-way, clearance-aware topology used by compilation, P8, and coaching. */
export function findMazeRoute(
  start: MazePoint,
  target: MazePoint,
  heroWidth: number,
  heroHeight: number,
  obstacles: readonly PlannedEntity[],
): MazePoint[] | undefined {
  const cellSize = 20;
  const columns = Math.ceil(WORLD_WIDTH / cellSize);
  const rows = Math.ceil(WORLD_HEIGHT / cellSize);
  const indexOf = (column: number, row: number): number => row * columns + column;
  const coordinates = (index: number): [number, number] => [index % columns, Math.floor(index / columns)];
  const columnFor = (x: number): number => clamp(Math.floor(x / cellSize), 0, columns - 1);
  const rowFor = (y: number): number => clamp(Math.floor(y / cellSize), 0, rows - 1);
  const centre = (column: number, row: number): MazePoint => ({
    x: clamp(column * cellSize + cellSize / 2, heroWidth / 2, WORLD_WIDTH - heroWidth / 2),
    y: clamp(row * cellSize + cellSize / 2, heroHeight / 2, WORLD_HEIGHT - heroHeight / 2),
  });
  const startIndex = indexOf(columnFor(start.x), rowFor(start.y));
  const targetIndex = indexOf(columnFor(target.x), rowFor(target.y));
  const blocked = (column: number, row: number): boolean => obstacles.some((obstacle) => (
    overlaps(
      centre(column, row),
      heroWidth + MAZE_ROUTE_CLEARANCE_PADDING,
      heroHeight + MAZE_ROUTE_CLEARANCE_PADDING,
      obstacle,
    )
  ));

  const parent = new Int32Array(columns * rows);
  parent.fill(-2);
  parent[startIndex] = -1;
  const queue = [startIndex];
  const directions: ReadonlyArray<readonly [number, number]> = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  for (let cursor = 0; cursor < queue.length && parent[targetIndex] === -2; cursor += 1) {
    const current = queue[cursor]!;
    const [column, row] = coordinates(current);
    for (const [dx, dy] of directions) {
      const nextColumn = column + dx;
      const nextRow = row + dy;
      if (nextColumn < 0 || nextRow < 0 || nextColumn >= columns || nextRow >= rows) continue;
      const next = indexOf(nextColumn, nextRow);
      if (parent[next] !== -2) continue;
      if (next !== targetIndex && blocked(nextColumn, nextRow)) continue;
      parent[next] = current;
      queue.push(next);
    }
  }
  if (parent[targetIndex] === -2) return undefined;

  const reversed: MazePoint[] = [];
  for (let index = targetIndex; index !== startIndex; index = parent[index]!) {
    const [column, row] = coordinates(index);
    reversed.push(centre(column, row));
  }
  reversed.reverse();
  reversed.push(target);
  return reversed;
}

interface StripEdges {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function stripEdges(strip: PlannedEntity): StripEdges {
  return {
    left: strip.x - strip.width / 2,
    right: strip.x + strip.width / 2,
    top: strip.y - strip.height / 2,
    bottom: strip.y + strip.height / 2,
  };
}

/**
 * Sub-strip extraction jitter: two runs reading the same drawn wall may
 * disagree about strip edges by a few pixels. Seams within this tolerance are
 * treated as the same drawn line; it is far below any hero clearance, so a
 * genuinely passable corridor can never be closed by alignment alone.
 */
const STRIP_ALIGN_TOLERANCE = 6;

/**
 * Deterministically merges adjacent/collinear same-role wall strips whose
 * seams no admissible hero could ever pass. Extraction naturally fragments
 * one drawn wall into several strips with sub-clearance seams, and the exact
 * fragmentation flutters run to run; equivalent strip sets must produce
 * equivalent topology, so sub-clearance seams are sealed before any
 * clearance decision reads the walls. `sealableGapBelow` must be the
 * smallest clearance any admissible hero can use (collision size plus
 * MAZE_ROUTE_CLEARANCE_PADDING): gaps at or above it are genuinely passable
 * corridors and are never sealed. Pure, bounded, geometry-only.
 */
export function mergeAdjacentWallStrips(
  walls: readonly PlannedEntity[],
  sealableGapBelow: number,
): PlannedEntity[] {
  const strips = [...walls].sort((first, second) => (
    (first.x - first.width / 2) - (second.x - second.width / 2) ||
    (first.y - first.height / 2) - (second.y - second.height / 2) ||
    first.id.localeCompare(second.id)
  ));
  const shouldMerge = (first: PlannedEntity, second: PlannedEntity): boolean => {
    if (first.role !== second.role) return false;
    const a = stripEdges(first);
    const b = stripEdges(second);
    const gapX = Math.max(a.left, b.left) - Math.min(a.right, b.right);
    const gapY = Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom);
    const collinearHorizontally =
      Math.abs(a.top - b.top) <= STRIP_ALIGN_TOLERANCE &&
      Math.abs(a.bottom - b.bottom) <= STRIP_ALIGN_TOLERANCE;
    const collinearVertically =
      Math.abs(a.left - b.left) <= STRIP_ALIGN_TOLERANCE &&
      Math.abs(a.right - b.right) <= STRIP_ALIGN_TOLERANCE;
    if (collinearHorizontally && gapY <= 0 && gapX < sealableGapBelow) return true;
    if (collinearVertically && gapX <= 0 && gapY < sealableGapBelow) return true;
    return false;
  };
  // Each pass performs at most one merge and restarts, so the loop is bounded
  // by the strip count and the scan order keeps the outcome deterministic.
  let merged = true;
  while (merged) {
    merged = false;
    scan:
    for (let index = 0; index < strips.length; index += 1) {
      for (let other = index + 1; other < strips.length; other += 1) {
        const first = strips[index]!;
        const second = strips[other]!;
        if (!shouldMerge(first, second)) continue;
        const a = stripEdges(first);
        const b = stripEdges(second);
        const left = Math.min(a.left, b.left);
        const right = Math.max(a.right, b.right);
        const top = Math.min(a.top, b.top);
        const bottom = Math.max(a.bottom, b.bottom);
        strips[index] = {
          ...first,
          x: (left + right) / 2,
          y: (top + bottom) / 2,
          width: right - left,
          height: bottom - top,
        };
        strips.splice(other, 1);
        merged = true;
        break scan;
      }
    }
  }
  return strips;
}

export interface MazeTopologyInput {
  hero: PlannedEntity;
  goal: PlannedEntity;
  walls: PlannedEntity[];
  doors: PlannedEntity[];
  hazards: PlannedEntity[];
  collectibles: PlannedEntity[];
  requiredCollectibleIds: string[];
  relationships: KeyDoorRelationship[];
  collectAll: boolean;
  colliderScale: number;
}

export function mazeTopologyIsFinishable(input: MazeTopologyInput): boolean {
  if (input.walls.length === 0) return false;
  const heroWidth = input.hero.width * input.colliderScale;
  const heroHeight = input.hero.height * input.colliderScale;
  const directDistance = Math.hypot(input.goal.x - input.hero.x, input.goal.y - input.hero.y);
  const directSteps = Math.max(1, Math.ceil(directDistance / 10));
  const directPathIsObstructed = Array.from({ length: directSteps + 1 }, (_, index) => ({
    x: input.hero.x + (input.goal.x - input.hero.x) * index / directSteps,
    y: input.hero.y + (input.goal.y - input.hero.y) * index / directSteps,
  })).some((point) => input.walls.some((wall) => overlaps(
    point,
    heroWidth + MAZE_ROUTE_CLEARANCE_PADDING,
    heroHeight + MAZE_ROUTE_CLEARANCE_PADDING,
    wall,
  )));
  // A page with decorative support geometry but an unobstructed direct line
  // is not truthfully a maze. It remains playable only as a related fallback.
  if (!directPathIsObstructed) return false;
  const collected = new Set<string>();
  let current: MazePoint = input.hero;
  const remaining = input.collectibles.filter((entity) => (
    input.collectAll || input.requiredCollectibleIds.includes(entity.id)
  ));
  while (remaining.length > 0) {
    remaining.sort((left, right) => (
      Math.hypot(left.x - current.x, left.y - current.y) - Math.hypot(right.x - current.x, right.y - current.y) ||
      left.id.localeCompare(right.id)
    ));
    const unlockedDoors = new Set(input.relationships
      .filter((relationship) => collected.has(relationship.keyId))
      .map((relationship) => relationship.doorId));
    const obstacles = [
      ...input.walls,
      ...input.doors.filter((door) => !unlockedDoors.has(door.id)),
      ...input.hazards,
    ];
    const targetIndex = remaining.findIndex((candidate) => (
      findMazeRoute(current, candidate, heroWidth, heroHeight, obstacles) !== undefined
    ));
    if (targetIndex < 0) return false;
    const [target] = remaining.splice(targetIndex, 1);
    if (!target) return false;
    collected.add(target.id);
    current = target;
  }
  const unlockedDoors = new Set(input.relationships
    .filter((relationship) => collected.has(relationship.keyId))
    .map((relationship) => relationship.doorId));
  return findMazeRoute(current, input.goal, heroWidth, heroHeight, [
    ...input.walls,
    ...input.doors.filter((door) => !unlockedDoors.has(door.id)),
    ...input.hazards,
  ]) !== undefined;
}
