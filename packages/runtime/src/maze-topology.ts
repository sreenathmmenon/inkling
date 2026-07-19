import type { KeyDoorRelationship } from "./relationship-contract.js";
import type { PlannedEntity } from "./platformer-layout.js";
import { WORLD_HEIGHT, WORLD_WIDTH } from "./world-geometry.js";

export interface MazePoint {
  x: number;
  y: number;
}

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
    overlaps(centre(column, row), heroWidth + 8, heroHeight + 8, obstacle)
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
    heroWidth + 8,
    heroHeight + 8,
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
