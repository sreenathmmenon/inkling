/**
 * REVIEW GATE — deterministic replay evidence policies.
 *
 * Protects: the input policies used to certify games (baseline, idle, noisy,
 * recovery, assist) stay deterministic, contiguous, and true to their intent,
 * so certification evidence means what it claims (Non-Negotiable 6).
 * Why it may not be weakened: a drifted policy silently certifies games under
 * easier conditions than a real child produces.
 */
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
  // Property, not a pinned frame index: assist is pressed exactly once, at the
  // end of a sustained stuck prefix (long enough for the runtime to have
  // earned the assist offer at fixed-step 60 fps), and strictly before the
  // original solving inputs resume.
  const assistPresses = assisted.filter((input) => input.assist);
  assert.equal(assistPresses.length, 1);
  const assistFrame = assistPresses[0]!.frame;
  const stuckPrefixLength = assisted.length - baseline.length;
  assert.equal(assistFrame, stuckPrefixLength, "assist must end the stuck prefix, before solving inputs resume");
  assert.ok(assistFrame >= 600, "stuck prefix is too short to have earned the assist offer (needs >= 10s at 60fps)");
  assert.ok(assisted.slice(stuckPrefixLength).every((input, index) => (
    input.frame === stuckPrefixLength + index + 1 && !input.assist
  )), "solving inputs after assist must stay contiguous and assist-free");
});
