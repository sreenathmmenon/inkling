import assert from "node:assert/strict";
import test from "node:test";

import {
  freshPlayerState,
  shouldShowAssist,
} from "../apps/client/src/player-status.js";
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

test("help is offered once and stays hidden while its boost is active", () => {
  const state = {
    status: "playing" as const,
    lives: 3,
    collected: 0,
    collectibleTotal: 2,
    assistAvailable: true,
    assistActive: false,
  };

  assert.equal(shouldShowAssist(state), true);
  assert.equal(shouldShowAssist({ ...state, assistActive: true }), false);
  assert.equal(shouldShowAssist({ ...state, status: "won" }), false);
  assert.equal(shouldShowAssist({ ...state, assistAvailable: false }), false);
});
