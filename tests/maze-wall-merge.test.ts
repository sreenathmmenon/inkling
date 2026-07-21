import assert from "node:assert/strict";
import test from "node:test";

import {
  findMazeRoute,
  mergeAdjacentWallStrips,
} from "../packages/runtime/src/maze-topology.js";
import {
  createPlatformerPlan,
  type PlannedEntity,
} from "../packages/runtime/src/platformer-layout.js";
import type { GameSpec } from "../runner/types.js";

const CLEARANCE = 30;

function strip(
  id: string,
  left: number,
  top: number,
  right: number,
  bottom: number,
  role = "platform",
): PlannedEntity {
  return {
    id,
    role,
    styleRef: "source",
    artworkSource: "drawing",
    x: (left + right) / 2,
    y: (top + bottom) / 2,
    width: right - left,
    height: bottom - top,
  };
}

function box(entity: PlannedEntity): [number, number, number, number] {
  return [
    entity.x - entity.width / 2,
    entity.y - entity.height / 2,
    entity.x + entity.width / 2,
    entity.y + entity.height / 2,
  ];
}

test("collinear same-role strips with sub-clearance seams merge into one wall", () => {
  const merged = mergeAdjacentWallStrips([
    strip("a", 450, 0, 508, 160),
    strip("b", 450, 168, 508, 320),
    strip("c", 450, 326, 508, 480),
  ], CLEARANCE);
  assert.equal(merged.length, 1);
  assert.deepEqual(box(merged[0]!), [450, 0, 508, 480], "the merged wall covers the union");
  assert.equal(merged[0]!.id, "a", "identity stays with the first strip in deterministic order");
  assert.equal(merged[0]!.role, "platform");
});

test("a gap at or above the clearance threshold is a real corridor and is never sealed", () => {
  // Exactly at the threshold: not sealable.
  const boundary = mergeAdjacentWallStrips([
    strip("upper", 450, 0, 508, 200),
    strip("lower", 450, 200 + CLEARANCE, 508, 540),
  ], CLEARANCE);
  assert.equal(boundary.length, 2, "a corridor exactly at clearance stays open");

  // Comfortably open: the corridor stays open and stays routable.
  const open = mergeAdjacentWallStrips([
    strip("upper", 450, 0, 508, 180),
    strip("lower", 450, 260, 508, 540),
  ], CLEARANCE);
  assert.equal(open.length, 2, "an open corridor stays open");
  const route = findMazeRoute(
    { x: 100, y: 220 },
    { x: 860, y: 220 },
    14,
    14,
    open,
  );
  assert.ok(route, "a small hero still routes through the drawn corridor");
});

test("strips merge only when same-role and collinear within tolerance", () => {
  const differentRole = mergeAdjacentWallStrips([
    strip("a", 450, 0, 508, 160),
    strip("b", 450, 164, 508, 320, "ice"),
  ], CLEARANCE);
  assert.equal(differentRole.length, 2, "different roles never merge");

  const tJunction = mergeAdjacentWallStrips([
    strip("upright", 450, 0, 470, 300),
    strip("crossbar", 300, 296, 620, 316),
  ], CLEARANCE);
  assert.equal(tJunction.length, 2, "a T junction is not collinear and keeps both strips");
});

test("merging is deterministic and order-independent", () => {
  const strips = [
    strip("a", 450, 0, 508, 160),
    strip("b", 450, 168, 508, 320),
    strip("c", 450, 326, 508, 480),
    strip("d", 100, 100, 260, 130),
    strip("e", 268, 100, 400, 130),
  ];
  const forward = mergeAdjacentWallStrips(strips, CLEARANCE);
  const reversed = mergeAdjacentWallStrips([...strips].reverse(), CLEARANCE);
  const canonical = (walls: PlannedEntity[]): string =>
    walls.map(box).map((edges) => edges.map((edge) => edge.toFixed(3)).join(","))
      .sort().join(";");
  assert.equal(forward.length, 2);
  assert.equal(canonical(forward), canonical(reversed));
});

function mazeSpec(walls: Array<{ id: string; bbox: [number, number, number, number] }>): GameSpec {
  return {
    primary_genre: "maze", genre_confidence: 1, mood: null,
    hero: { id: "hero", name: "Hero", bbox: [0.05, 0.1, 0.15, 0.28], style_ref: "source" },
    entities: [
      ...walls.map((wall) => ({
        id: wall.id,
        role: "platform",
        bbox: wall.bbox,
        behavior: "static",
        linked_to: null,
        style_ref: "source",
      })),
      { id: "finish", role: "goal", bbox: [0.85, 0.1, 0.93, 0.3], behavior: "static", linked_to: null, style_ref: "source" },
    ],
    goal: { kind: "reach_goal", target_id: "finish" },
    rules: { lives: 3, difficulty_hint: "normal", modifiers: [] },
    palette: ["#ffffff", "#222222"], assumptions: [], flags: [],
  };
}

/** Fragments a wall's vertical span into strips separated by tiny seams. */
function fragmented(
  id: string,
  left: number,
  right: number,
  top: number,
  bottom: number,
  pieces: number,
): Array<{ id: string; bbox: [number, number, number, number] }> {
  const seam = 0.004;
  const step = (bottom - top) / pieces;
  return Array.from({ length: pieces }, (_, index) => ({
    id: `${id}_${index + 1}`,
    bbox: [
      left,
      top + index * step + (index === 0 ? 0 : seam / 2),
      right,
      top + (index + 1) * step - (index === pieces - 1 ? 0 : seam / 2),
    ] as [number, number, number, number],
  }));
}

test("equivalent fragmented and contiguous maze extractions converge to equivalent topology", () => {
  // The measured crayon-maze profile fluttered between 22 and 28 strips for
  // the same drawn walls; here the same three-wall maze is read once as three
  // strips and once as 26, and both must compile to the same collision truth.
  const solidWalls: Array<{ id: string; bbox: [number, number, number, number] }> = [
    { id: "wall_a", bbox: [0.25, 0, 0.31, 0.7] },
    { id: "wall_b", bbox: [0.45, 0.3, 0.51, 1] },
    { id: "wall_c", bbox: [0.65, 0, 0.71, 0.7] },
  ];
  const fragmentedWalls = [
    ...fragmented("wall_a", 0.25, 0.31, 0, 0.7, 9),
    ...fragmented("wall_b", 0.45, 0.51, 0.3, 1, 9),
    ...fragmented("wall_c", 0.65, 0.71, 0, 0.7, 8),
  ];
  assert.equal(fragmentedWalls.length, 26);

  const solidPlan = createPlatformerPlan(mazeSpec(solidWalls));
  const fragmentedPlan = createPlatformerPlan(mazeSpec(fragmentedWalls));

  assert.equal(solidPlan.mazeTopologyFallback, false);
  assert.equal(fragmentedPlan.mazeTopologyFallback, false, "fragmentation must not seal a finishable maze");
  assert.equal(solidPlan.mazeCollisionWalls.length, 3);
  assert.equal(
    fragmentedPlan.mazeCollisionWalls.length,
    3,
    "26 strips with sub-clearance seams converge to the same three walls",
  );
  const sortedBoxes = (walls: PlannedEntity[]): number[][] =>
    walls.map(box).sort((first, second) => first[0]! - second[0]!);
  const solidBoxes = sortedBoxes(solidPlan.mazeCollisionWalls);
  const fragmentedBoxes = sortedBoxes(fragmentedPlan.mazeCollisionWalls);
  for (let index = 0; index < solidBoxes.length; index += 1) {
    for (let edge = 0; edge < 4; edge += 1) {
      assert.ok(
        Math.abs(solidBoxes[index]![edge]! - fragmentedBoxes[index]![edge]!) < 1.5,
        `wall ${index} edge ${edge} agrees between extractions`,
      );
    }
  }
  assert.equal(solidPlan.hero.width, fragmentedPlan.hero.width, "both extractions fit the same hero");
  assert.equal(solidPlan.hero.height, fragmentedPlan.hero.height);
});

test("a fully sealing wall seals the maze whether extracted whole or fragmented", () => {
  const solid = createPlatformerPlan(mazeSpec([{ id: "wall", bbox: [0.47, 0, 0.53, 1] }]));
  const split = createPlatformerPlan(mazeSpec(fragmented("wall", 0.47, 0.53, 0, 1, 6)));
  assert.equal(solid.mazeTopologyFallback, true);
  assert.equal(split.mazeTopologyFallback, true, "sub-clearance seams never fake an opening");
  assert.deepEqual(solid.mazeCollisionWalls, []);
  assert.deepEqual(split.mazeCollisionWalls, []);
});
