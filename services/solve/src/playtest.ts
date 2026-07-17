import type { BoundingEntity, GameSpec, PlaytestReport } from "../../../runner/types.js";

const DEFAULT_SEED = 0x1a2b3c4d;

function center(bbox: [number, number, number, number]): [number, number] {
  return [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
}

function edgeGap(
  left: [number, number, number, number],
  right: [number, number, number, number],
): [number, number] {
  const horizontal = Math.max(0, left[0] - right[2], right[0] - left[2]);
  const vertical = Math.max(0, left[1] - right[3], right[1] - left[3]);
  return [horizontal, vertical];
}

function canTraverse(
  from: [number, number, number, number],
  to: [number, number, number, number],
  genre: string,
): boolean {
  const [horizontal, vertical] = edgeGap(from, to);
  if (genre === "maze" || genre === "tower_defense") {
    return horizontal <= 0.16 && vertical <= 0.16;
  }
  if (genre === "runner" || genre === "roller") {
    return horizontal <= 0.25 && vertical <= 0.2;
  }
  return horizontal <= 0.22 && vertical <= 0.24;
}

function traversable(entity: BoundingEntity): boolean {
  return !["hazard", "enemy", "boss", "decoration"].includes(entity.role);
}

function targetIds(gameSpec: GameSpec): string[] {
  if (gameSpec.goal.kind === "collect_all") {
    return gameSpec.entities
      .filter((entity) => entity.role === "collectible")
      .map((entity) => entity.id);
  }
  if (gameSpec.goal.target_id) return [gameSpec.goal.target_id];
  if (gameSpec.goal.kind === "defeat_boss") {
    const boss = gameSpec.entities.find((entity) => entity.role === "boss");
    return boss ? [boss.id] : [];
  }
  const goal = gameSpec.entities.find((entity) => entity.role === "goal");
  return goal ? [goal.id] : [];
}

/**
 * Deterministic, headless reachability pass used before the reasoning verdict.
 * It operates on normalized Phaser-world geometry and never uses wall-clock time
 * or unseeded randomness.
 */
export function runPlaytest(
  gameSpec: GameSpec,
  seed = DEFAULT_SEED,
): PlaytestReport {
  if (gameSpec.goal.kind === "survive") {
    return {
      reached_goal: true,
      first_blocker: null,
      time_to_win: 30,
      seed,
      visited: [gameSpec.hero.id],
    };
  }

  const targets = targetIds(gameSpec);
  if (targets.length === 0) {
    return {
      reached_goal: false,
      first_blocker: "missing_goal",
      time_to_win: null,
      seed,
      visited: [gameSpec.hero.id],
    };
  }

  const nodes = [
    { id: gameSpec.hero.id, bbox: gameSpec.hero.bbox },
    ...gameSpec.entities
      .filter((entity) => traversable(entity) || targets.includes(entity.id))
      .map((entity) => ({ id: entity.id, bbox: entity.bbox })),
  ];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const queue: Array<{ id: string; hops: number }> = [
    { id: gameSpec.hero.id, hops: 0 },
  ];
  const visited = new Set<string>();
  let winningHops = 0;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current.id)) continue;
    visited.add(current.id);
    winningHops = Math.max(winningHops, current.hops);
    const source = byId.get(current.id);
    if (!source) continue;
    for (const candidate of nodes) {
      if (
        !visited.has(candidate.id) &&
        canTraverse(source.bbox, candidate.bbox, gameSpec.primary_genre)
      ) {
        queue.push({ id: candidate.id, hops: current.hops + 1 });
      }
    }
  }

  const reached = targets.every((target) => visited.has(target));
  let firstBlocker: string | null = null;
  if (!reached) {
    const target = byId.get(targets.find((id) => !visited.has(id)) ?? "");
    if (target) {
      const [x, y] = center(target.bbox);
      firstBlocker = `unreachable:${target.id}@${x.toFixed(3)},${y.toFixed(3)}`;
    } else {
      firstBlocker = "target_not_found";
    }
  }

  return {
    reached_goal: reached,
    first_blocker: firstBlocker,
    time_to_win: reached ? Number((winningHops * 0.75 + 0.5).toFixed(2)) : null,
    seed,
    visited: [...visited],
  };
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
