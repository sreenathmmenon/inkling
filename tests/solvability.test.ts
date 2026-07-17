import assert from "node:assert/strict";
import test from "node:test";

import { validateBehaviorOperation } from "../packages/sdk/src/validator.js";
import {
  applyBoundedRepairs,
  runPlaytest,
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

test("headless playtest is deterministic and bounded repairs are enforced", () => {
  const game = fixture();
  const first = runPlaytest(game, 42);
  const second = runPlaytest(game, 42);
  assert.deepEqual(first, second);
  assert.equal(first.reached_goal, false);
  const rejected = applyBoundedRepairs(game, [
    { target_id: "goal_1", op: "move", value: [-0.2, 0] },
  ]);
  assert.equal(rejected.applied, 0);
  assert.match(rejected.rejected[0] ?? "", /out_of_bounds/);
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
