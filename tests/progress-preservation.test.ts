import assert from "node:assert/strict";
import test from "node:test";

import { createPlatformerPlan } from "../packages/runtime/src/platformer-layout.js";
import { carriedCollectibleIds } from "../packages/runtime/src/progress-preservation.js";
import type { GameSpec } from "../runner/types.js";

/** A rescanned world: bonus gems, a key that gates a door, and a goal. */
const GROWN_WORLD: GameSpec = {
  primary_genre: "platformer",
  genre_confidence: 1,
  mood: null,
  hero: { id: "hero", name: "Hero", bbox: [0.05, 0.5, 0.15, 0.7], style_ref: "source" },
  entities: [
    { id: "floor", role: "platform", bbox: [0, 0.72, 1, 0.8], behavior: "static", linked_to: null, style_ref: "source" },
    { id: "gem_1", role: "collectible", bbox: [0.3, 0.6, 0.34, 0.68], behavior: "static", linked_to: null, style_ref: "source" },
    { id: "gem_2", role: "collectible", bbox: [0.4, 0.6, 0.44, 0.68], behavior: "static", linked_to: null, style_ref: "source" },
    { id: "key_1", role: "key", bbox: [0.5, 0.6, 0.54, 0.68], behavior: "static", linked_to: "door_1", style_ref: "source" },
    { id: "door_1", role: "door", bbox: [0.62, 0.4, 0.66, 0.8], behavior: "static", linked_to: null, style_ref: "source" },
    { id: "finish", role: "goal", bbox: [0.85, 0.5, 0.95, 0.7], behavior: "static", linked_to: null, style_ref: "source" },
  ],
  goal: { kind: "reach_goal", target_id: "finish" },
  rules: { lives: 3, difficulty_hint: "normal", modifiers: [] },
  palette: ["#333333"],
  assumptions: [],
  flags: [],
};

test("bonus collectibles that survive a rescan carry forward; everything else starts fresh", () => {
  const plan = createPlatformerPlan(GROWN_WORLD);
  assert.ok(plan.requiredCollectibleIds.includes("key_1"), "the relationship key gates the door");

  const carried = carriedCollectibleIds(plan, ["gem_1", "erased_gem", "key_1"]);
  assert.deepEqual(carried, ["gem_1"]);
  assert.equal(carried.includes("erased_gem"), false, "an id the merge dropped starts fresh");
  assert.equal(
    carried.includes("key_1"),
    false,
    "required keys are earned again so the door-unlock sequence stays the certified one",
  );
});

test("the carry rule is deterministic, ordered, and deduplicated", () => {
  const plan = createPlatformerPlan(GROWN_WORLD);
  assert.deepEqual(carriedCollectibleIds(plan, ["gem_2", "gem_1", "gem_2"]), ["gem_2", "gem_1"]);
  assert.deepEqual(carriedCollectibleIds(plan, []), []);
  assert.deepEqual(
    carriedCollectibleIds(plan, ["gem_2", "gem_1", "gem_2"]),
    carriedCollectibleIds(plan, ["gem_2", "gem_1", "gem_2"]),
  );
});

test("a collect_all goal never pre-collects: gathering is the game", () => {
  const collectAllWorld = structuredClone(GROWN_WORLD);
  collectAllWorld.goal = { kind: "collect_all", target_id: null };
  const plan = createPlatformerPlan(collectAllWorld);
  assert.equal(plan.goalKind, "collect_all");
  assert.deepEqual(carriedCollectibleIds(plan, ["gem_1", "gem_2"]), []);
});
