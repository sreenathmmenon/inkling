import assert from "node:assert/strict";
import test from "node:test";

import { validateBehaviorOperation } from "../packages/sdk/src/validator.js";
import {
  applyBoundedRepairs,
  runPlaytest,
  runPlaytestWithTrace,
} from "../services/solve/src/playtest.js";
import type { GameSpec } from "../runner/types.js";

function fixture(): GameSpec {
  return {
    primary_genre: "platformer",
    genre_confidence: 1,
    hero: {
      id: "hero_1",
      name: "Hero",
      bbox: [0.05, 0.5, 0.15, 0.7],
      style_ref: "source",
    },
    entities: [
      {
        id: "goal_1",
        role: "goal",
        bbox: [0.75, 0.5, 0.85, 0.7],
        behavior: "static",
        style_ref: "source",
      },
    ],
    goal: { kind: "reach_goal", target_id: "goal_1" },
    rules: { lives: 3, difficulty_hint: "normal", modifiers: [] },
    palette: ["source"],
    assumptions: [],
    flags: [],
  };
}

test("Lane A playtest uses the same deterministic physics contract as the player", () => {
  const game = fixture();
  const first = runPlaytest(game, 42);
  const second = runPlaytest(game, 42);
  assert.deepEqual(first, second);
  assert.equal(first.reached_goal, true);
  assert.ok(first.time_to_win !== null && first.time_to_win > 0);
  assert.ok(first.visited.includes("lane_a_safety_floor"));
  const rejected = applyBoundedRepairs(game, [
    { target_id: "goal_1", op: "move", value: [-0.2, 0] },
  ]);
  assert.equal(rejected.applied, 0);
  assert.match(rejected.rejected[0] ?? "", /out_of_bounds/);
});

test("analytic playtest emits shared InputFrames for production Phaser replay", () => {
  const first = runPlaytestWithTrace(fixture(), 42);
  const second = runPlaytestWithTrace(fixture(), 42);
  assert.deepEqual(first, second);
  assert.equal(first.report.reached_goal, true);
  assert.equal(first.inputFrames[0]?.format, "inkling-input-frame-v1");
  assert.equal(first.inputFrames[0]?.frame, 1);
  assert.ok(first.inputFrames.some((input) => input.right));
  assert.ok(first.inputFrames.every((input, index) => input.frame === index + 1));
});

test("Lane A normalizes a repeated spawn hazard into a safe, finishable start", () => {
  const game = fixture();
  game.rules.lives = 1;
  game.entities.push({
    id: "spawn_hazard",
    role: "hazard",
    bbox: [0.05, 0.5, 0.15, 0.7],
    behavior: "static",
    style_ref: "source",
  });
  const report = runPlaytest(game, 42);
  assert.equal(report.reached_goal, true, report.first_blocker ?? "no report");
  assert.equal(report.visited.includes("spawn_hazard"), false);
});

test("Lane A solver uses the no-gravity free-movement contract for roller games", () => {
  const game = fixture();
  game.primary_genre = "roller";
  game.hero.bbox = [0.1, 0.1, 0.18, 0.22];
  game.entities[0]!.bbox = [0.72, 0.72, 0.82, 0.84];
  game.rules.modifiers = [];

  const report = runPlaytest(game, 42);
  assert.equal(report.reached_goal, true);
  assert.ok(report.time_to_win !== null && report.time_to_win > 0);
  assert.equal(report.visited.includes("lane_a_safety_floor"), false);
});

test("free-movement P8 routes around hazards instead of exhausting lives", () => {
  const game = fixture();
  game.primary_genre = "roller";
  game.hero.bbox = [0.08, 0.42, 0.16, 0.56];
  game.entities = [
    { id: "rock", role: "hazard", bbox: [0.42, 0.3, 0.58, 0.7], behavior: "static", style_ref: "source" },
    { id: "goal", role: "goal", bbox: [0.8, 0.42, 0.9, 0.58], behavior: "static", style_ref: "source" },
  ];
  game.goal = { kind: "reach_goal", target_id: "goal" };

  const report = runPlaytest(game, 42);
  assert.equal(report.reached_goal, true, report.first_blocker ?? "no report");
  assert.equal(report.visited.includes("rock"), false);
});

test("collect-all wins on the last collectible just like the Phaser player", () => {
  const game = fixture();
  game.primary_genre = "roller";
  game.hero.bbox = [0.1, 0.1, 0.18, 0.22];
  game.entities = [{
    id: "star_1",
    role: "collectible",
    bbox: [0.7, 0.7, 0.78, 0.8],
    behavior: "static",
    style_ref: "source",
  }];
  game.goal = { kind: "collect_all", target_id: null };
  game.rules.modifiers = [];

  const report = runPlaytest(game, 42);
  assert.equal(report.reached_goal, true);
  assert.ok(report.visited.includes("star_1"));
});

test("ground-mode P8 routes through required collectibles before finishing", () => {
  const game = fixture();
  game.entities = [
    { id: "item_1", role: "collectible", bbox: [0.35, 0.55, 0.41, 0.66], behavior: "static", style_ref: "source" },
    { id: "item_2", role: "collectible", bbox: [0.65, 0.55, 0.71, 0.66], behavior: "static", style_ref: "source" },
  ];
  game.goal = { kind: "collect_all", target_id: null };

  const report = runPlaytest(game, 42);
  assert.equal(report.reached_goal, true, report.first_blocker ?? "no report");
  assert.ok(report.visited.includes("item_1"));
  assert.ok(report.visited.includes("item_2"));
});

test("ground-mode P8 walks off a high platform when the goal is below", () => {
  const game = fixture();
  game.hero.bbox = [0.68, 0.12, 0.76, 0.28];
  game.entities = [
    { id: "upper", role: "platform", bbox: [0.58, 0.3, 0.92, 0.36], behavior: "static", style_ref: "source" },
    { id: "goal", role: "goal", bbox: [0.72, 0.72, 0.82, 0.86], behavior: "static", style_ref: "source" },
  ];
  game.goal = { kind: "reach_goal", target_id: "goal" };

  const report = runPlaytest(game, 42);
  assert.equal(report.reached_goal, true, report.first_blocker ?? "no report");
});

test("ground reach-goal routing targets the playable trigger instead of climbing into unrelated art", () => {
  const game = fixture();
  game.primary_genre = "runner";
  game.hero.bbox = [0.25, 0.46, 0.51, 0.65];
  game.entities = [
    { id: "cloud_high", role: "cloud", bbox: [0.44, 0.59, 0.91, 0.78], behavior: "static", style_ref: "source" },
    { id: "cloud_floor", role: "cloud", bbox: [0.01, 0.72, 0.98, 0.95], behavior: "static", style_ref: "source" },
    { id: "hazard", role: "hazard", bbox: [0.56, 0.38, 0.64, 0.49], behavior: "static", style_ref: "source" },
    { id: "goal", role: "goal", bbox: [0.71, 0.2, 0.91, 0.39], behavior: "static", style_ref: "source" },
  ];
  game.goal = { kind: "reach_goal", target_id: "goal" };

  const report = runPlaytest(game, 42);

  assert.equal(report.reached_goal, true, report.first_blocker ?? "no report");
});

test("ground-mode P8 jumps a hazard waiting below the end of a drawn ledge", () => {
  const game = fixture();
  game.hero.bbox = [0.11, 0.72, 0.23, 0.85];
  game.entities = [
    { id: "start", role: "platform", bbox: [0.06, 0.8, 0.38, 0.94], behavior: "static", linked_to: null, style_ref: "source" },
    { id: "pit", role: "hazard", bbox: [0.42, 0.7, 0.58, 0.94], behavior: "static", linked_to: null, style_ref: "source" },
    { id: "goal", role: "goal", bbox: [0.82, 0.08, 0.9, 0.25], behavior: "static", linked_to: null, style_ref: "source" },
  ];
  game.goal = { kind: "reach_goal", target_id: "goal" };

  const report = runPlaytest(game, 42);

  assert.equal(report.reached_goal, true, report.first_blocker ?? "no report");
  assert.equal(report.visited.includes("pit"), false);
});

test("P8 clears a matrix of generic stacked and zig-zag platform layouts", () => {
  const layouts: Array<Array<[number, number, number, number]>> = [
    [
      [0.05, 0.82, 0.34, 0.88],
      [0.25, 0.68, 0.51, 0.74],
      [0.39, 0.54, 0.65, 0.6],
      [0.53, 0.4, 0.79, 0.46],
    ],
    [
      [0.05, 0.82, 0.31, 0.88],
      [0.25, 0.7, 0.49, 0.76],
      [0.1, 0.58, 0.34, 0.64],
      [0.3, 0.46, 0.54, 0.52],
      [0.15, 0.34, 0.39, 0.4],
    ],
    [
      [0.05, 0.82, 0.38, 0.88],
      [0.23, 0.73, 0.56, 0.79],
      [0.41, 0.64, 0.74, 0.7],
      [0.24, 0.55, 0.57, 0.61],
    ],
  ];

  for (const [layoutIndex, platforms] of layouts.entries()) {
    const game = fixture();
    game.hero.bbox = [0.08, 0.68, 0.16, 0.82];
    game.entities = platforms.flatMap((bbox, index) => [
      {
        id: `surface_${layoutIndex}_${index}`,
        role: "platform",
        bbox,
        behavior: "static",
        linked_to: null,
        style_ref: "source",
      },
      {
        id: `item_${layoutIndex}_${index}`,
        role: "collectible",
        bbox: [bbox[0] + 0.08, bbox[1] - 0.07, bbox[0] + 0.13, bbox[1]],
        behavior: "static",
        linked_to: null,
        style_ref: "source",
      },
    ]);
    game.goal = { kind: "collect_all", target_id: null };

    const report = runPlaytest(game, 42);

    assert.equal(
      report.reached_goal,
      true,
      `layout ${layoutIndex}: ${report.first_blocker}`,
    );
  }
});

test("P8 can validate a finishable route for every declared Lane A genre", () => {
  const genres = ["platformer", "maze", "runner", "roller", "shooter", "slingshot", "tower_defense"] as const;
  for (const primaryGenre of genres) {
    const game = fixture();
    game.primary_genre = primaryGenre;
    if (primaryGenre === "maze" || primaryGenre === "roller" || primaryGenre === "shooter" || primaryGenre === "slingshot" || primaryGenre === "tower_defense") {
      game.hero.bbox = [0.1, 0.12, 0.18, 0.26];
      game.entities[0]!.bbox = [0.72, 0.7, 0.82, 0.84];
    }
    const report = runPlaytest(game, 42);
    assert.equal(report.reached_goal, true, `${primaryGenre}: ${report.first_blocker}`);
  }
});

test("P8 validates the same projectile contract used for a defeat-boss game", () => {
  const game = fixture();
  game.primary_genre = "shooter";
  game.hero.bbox = [0.1, 0.2, 0.18, 0.34];
  game.entities = [{
    id: "boss", role: "boss", bbox: [0.72, 0.42, 0.84, 0.62], behavior: "static", style_ref: "source",
  }];
  game.goal = { kind: "defeat_boss", target_id: "boss" };
  const report = runPlaytest(game, 42);
  assert.equal(report.reached_goal, true, report.first_blocker ?? "no report");
  assert.ok(report.visited.includes("boss"));
});

test("validator executes accepted code only in the restricted sandbox", async () => {
  const valid = await validateBehaviorOperation(
    {
      type: "create_file",
      path: "behaviors/mover_1.js",
      diff: `defineBehavior({
  id: "mover_1",
  onUpdate(dt, ctx) { ctx.move(dt * ctx.rng(), 0); }
});`,
    },
    "mover_1",
  );
  assert.equal(valid.valid, true, valid.errors.join(","));

  const invalid = await validateBehaviorOperation(
    {
      type: "create_file",
      path: "behaviors/mover_1.js",
      diff: `defineBehavior({ id: "mover_1", onUpdate() { fetch("https://example.com"); } });`,
    },
    "mover_1",
  );
  assert.equal(invalid.valid, false);
  assert.equal(invalid.fallback, "static");
  assert.ok(invalid.errors.includes("forbidden_network"));
});
