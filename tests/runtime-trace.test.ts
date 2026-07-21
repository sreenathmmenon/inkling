import assert from "node:assert/strict";
import test from "node:test";

import { createPlayContract } from "../packages/runtime/src/play-contract.js";
import type { RuntimeEvent } from "../packages/runtime/src/runtime-events.js";
import type { GameSpec } from "../runner/types.js";
import { validateRuntimeTrace } from "../services/solve/src/runtime-trace.js";

const gameSpec: GameSpec = {
  primary_genre: "platformer", genre_confidence: 1, mood: null,
  hero: { id: "hero", name: "Hero", bbox: [0.1, 0.5, 0.2, 0.7], style_ref: "source" },
  entities: [
    { id: "floor", role: "platform", bbox: [0, 0.72, 1, 0.8], behavior: "static", linked_to: null, style_ref: "source" },
    { id: "finish", role: "goal", bbox: [0.8, 0.5, 0.9, 0.7], behavior: "static", linked_to: null, style_ref: "source" },
  ],
  goal: { kind: "reach_goal", target_id: "finish" },
  rules: { lives: 3, difficulty_hint: "normal", modifiers: [] },
  palette: ["#ffffff"], assumptions: [], flags: [],
};

function event(
  sequence: number,
  frame: number,
  kind: RuntimeEvent["kind"],
  status: RuntimeEvent["state"]["status"],
): RuntimeEvent {
  return {
    format: "inkling-runtime-event-v1",
    sequence,
    frame,
    kind,
    entityId: kind === "win" ? "finish" : null,
    required: kind === "win",
    state: {
      status,
      lives: 3,
      collected: 0,
      collectibleTotal: 0,
      assistAvailable: false,
      assistActive: false,
    },
  };
}

test("real-runtime trace evidence rejects an idle auto-win", () => {
  const report = validateRuntimeTrace([
    event(0, 0, "state_changed", "playing"),
    event(1, 94, "win", "won"),
    event(2, 94, "state_changed", "won"),
  ], createPlayContract(gameSpec));
  assert.equal(report.valid, false);
  assert.ok(report.blockers.includes("idle_win_without_accepted_input"));
});

test("real-runtime trace evidence accepts a legal input-backed win", () => {
  const report = validateRuntimeTrace([
    event(0, 0, "state_changed", "playing"),
    event(1, 3, "input_accepted", "playing"),
    { ...event(2, 4, "surface_landed", "playing"), entityId: "floor", required: true },
    event(3, 180, "win", "won"),
    event(4, 180, "state_changed", "won"),
  ], createPlayContract(gameSpec));
  assert.deepEqual(report.blockers, []);
  assert.equal(report.valid, true);
  assert.equal(report.inputAccepted, true);
  assert.equal(report.finalStatus, "won");
});

test("real-runtime trace evidence rejects a finish that bypasses required drawn interactions", () => {
  const withDrawnItem: GameSpec = structuredClone(gameSpec);
  withDrawnItem.entities.splice(1, 0, {
    id: "drawn_item",
    role: "key",
    bbox: [0.42, 0.6, 0.47, 0.68],
    behavior: "static",
    linked_to: "drawn_door",
    style_ref: "source",
  }, {
    id: "drawn_door",
    role: "door",
    bbox: [0.6, 0.45, 0.66, 0.72],
    behavior: "static",
    linked_to: null,
    style_ref: "source",
  });
  const report = validateRuntimeTrace([
    event(0, 0, "state_changed", "playing"),
    event(1, 3, "input_accepted", "playing"),
    { ...event(2, 4, "surface_landed", "playing"), entityId: "floor", required: true },
    event(3, 180, "win", "won"),
    event(4, 180, "state_changed", "won"),
  ], createPlayContract(withDrawnItem));

  assert.equal(report.valid, false);
  assert.ok(report.blockers.includes("required_interaction_missing:drawn_item"));
});
