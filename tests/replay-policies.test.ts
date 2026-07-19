import assert from "node:assert/strict";
import test from "node:test";

import { emptyInputFrame } from "../packages/runtime/src/input-frame.js";
import { applyReplayPolicy } from "../services/solve/src/replay-policies.js";

const baseline = Array.from({ length: 60 }, (_, index) => {
  const input = emptyInputFrame(index + 1);
  input.right = true;
  input.jump = index === 20;
  return input;
});

test("replay policy variants are deterministic, contiguous, and preserve their intent", () => {
  for (const policy of ["baseline", "idle", "delayed_noisy", "recovery", "assist_recovery"] as const) {
    const first = applyReplayPolicy(baseline, policy);
    const second = applyReplayPolicy(baseline, policy);
    assert.deepEqual(first, second);
    assert.ok(first.every((input, index) => input.frame === index + 1));
  }
  assert.ok(applyReplayPolicy(baseline, "idle").every((input) => (
    !input.left && !input.right && !input.jump && !input.down && !input.action && !input.assist
  )));
  assert.ok(applyReplayPolicy(baseline, "delayed_noisy").length > baseline.length);
  assert.ok(applyReplayPolicy(baseline, "recovery").slice(0, 45).every((input) => input.left));
  const assisted = applyReplayPolicy(baseline, "assist_recovery");
  assert.equal(assisted.filter((input) => input.assist).length, 1);
  assert.ok(assisted.find((input) => input.assist)?.frame === 720);
});
