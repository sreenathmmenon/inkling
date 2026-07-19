import assert from "node:assert/strict";
import test from "node:test";

import { freshPlayerState } from "../apps/client/src/player-status.js";
import { createPlatformerPlan } from "../packages/runtime/src/platformer-layout.js";
import { findProjectRoot, loadJson } from "../runner/spec.js";

test("a replay starts with fresh truthful status instead of retaining a win", () => {
  const plan = createPlatformerPlan(
    loadJson<unknown>(findProjectRoot(), "examples/live-scan-gamespec.json"),
  );

  assert.deepEqual(freshPlayerState(plan), {
    status: "playing",
    lives: plan.lives,
    collected: 0,
    collectibleTotal: plan.collectibles.length,
    assistAvailable: false,
    assistActive: false,
  });
});
