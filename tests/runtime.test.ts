import assert from "node:assert/strict";
import test from "node:test";

import {
  createPlatformerPlan,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from "../packages/runtime/src/platformer-layout.js";
import { findProjectRoot, loadJson } from "../runner/spec.js";

const liveSpec = loadJson<unknown>(findProjectRoot(), "examples/live-scan-gamespec.json");

test("Lane A maps the live scan deterministically into a playable physics plan", () => {
  const first = createPlatformerPlan(liveSpec);
  const second = createPlatformerPlan(liveSpec);

  assert.deepEqual(first, second);
  assert.equal(first.lives, 3);
  assert.equal(first.hero.id, "hero_1");
  assert.equal(first.hero.styleRef, "thick-dark-outline-yellow-clock-doodle");
  assert.equal(first.hero.x, 168);
  assert.ok(first.platforms.some((platform) => platform.id === "ground_1"));
  assert.ok(first.platforms.some((platform) => platform.id === "lane_a_safety_floor"));
  assert.ok(first.hazards.some((hazard) => hazard.id === "enemy_1"));
  assert.equal(first.goal.id, "goal_1");

  const safetyFloor = first.platforms.find((platform) => platform.id === "lane_a_safety_floor");
  assert.ok(safetyFloor);
  const floorTop = safetyFloor.y - safetyFloor.height / 2;
  const triggerBottom = first.goalTrigger.y + first.goalTrigger.height / 2;
  assert.ok(triggerBottom >= floorTop, "goal trigger must remain reachable from the safety floor");
});

test("Lane A always supplies a complete offline fallback for invalid input", () => {
  const plan = createPlatformerPlan(null);

  assert.equal(plan.goalKind, "reach_goal");
  assert.ok(plan.lives >= 1);
  assert.ok(plan.hero.x > 0 && plan.hero.x < WORLD_WIDTH);
  assert.ok(plan.hero.y > 0 && plan.hero.y < WORLD_HEIGHT);
  assert.ok(plan.platforms.length >= 1);
  assert.ok(plan.goalTrigger.width >= plan.goal.width);
  assert.ok(plan.goalTrigger.height >= plan.goal.height);
});

test("Lane A preserves lives and categorizes platformer interactions", () => {
  const plan = createPlatformerPlan({
    primary_genre: "platformer",
    genre_confidence: 1,
    mood: "bold",
    hero: {
      id: "hero",
      name: "Test Hero",
      bbox: [0.05, 0.6, 0.12, 0.75],
      style_ref: "hero-strokes",
    },
    entities: [
      { id: "ground", role: "platform", bbox: [0, 0.8, 1, 0.86], behavior: "static", style_ref: "ground-strokes" },
      { id: "spike", role: "hazard", bbox: [0.3, 0.74, 0.36, 0.8], behavior: "static", style_ref: "spike-strokes" },
      { id: "star", role: "collectible", bbox: [0.5, 0.65, 0.55, 0.72], behavior: "static", style_ref: "star-strokes" },
      { id: "flag", role: "goal", bbox: [0.88, 0.65, 0.94, 0.8], behavior: "static", style_ref: "flag-strokes" },
    ],
    goal: { kind: "reach_goal", target_id: "flag" },
    rules: { lives: 7, difficulty_hint: "normal", modifiers: [] },
    palette: ["#ffffff", "#111111", "#ffff00"],
    assumptions: [],
    flags: [],
  });

  assert.equal(plan.lives, 7);
  assert.deepEqual(plan.hazards.map((entity) => entity.id), ["spike"]);
  assert.deepEqual(plan.collectibles.map((entity) => entity.id), ["star"]);
  assert.equal(plan.goal.id, "flag");
  assert.equal(plan.goal.styleRef, "flag-strokes");
});
