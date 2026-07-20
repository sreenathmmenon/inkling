import assert from "node:assert/strict";
import test from "node:test";

import { GenerationAdmissionController } from "../services/gen/src/generation-admission.js";

function accepted(result: ReturnType<GenerationAdmissionController["begin"]>) {
  assert.equal(result.accepted, true);
  if (!result.accepted) throw new Error("expected admission");
  return result.lease;
}

test("same-session replacement waits for release and never exceeds the hard cap", async () => {
  const admission = new GenerationAdmissionController(2, 20, 60_000);
  const first = accepted(admission.begin("a", 0));
  const other = accepted(admission.begin("b", 0));
  await Promise.all([first.activate(), other.activate()]);
  assert.equal(admission.activeCount, 2);

  const replacement = accepted(admission.begin("a", 1));
  assert.equal(first.controller.signal.aborted, true);
  let activated = false;
  void replacement.activate().then(() => { activated = true; });
  await Promise.resolve();
  assert.equal(activated, false);
  assert.equal(admission.activeCount, 2);
  first.release();
  await replacement.activate();
  assert.equal(admission.activeCount, 2);
  replacement.release();
  other.release();
  assert.equal(admission.activeCount, 0);
});

test("every replacement attempt is rate-accounted before it can supersede work", () => {
  const admission = new GenerationAdmissionController(1, 3, 60_000);
  const first = accepted(admission.begin("same", 0));
  const second = accepted(admission.begin("same", 1));
  const third = accepted(admission.begin("same", 2));
  const rejected = admission.begin("same", 3);
  assert.deepEqual(rejected, { accepted: false, reason: "rate_limited" });
  assert.equal(third.controller.signal.aborted, false, "a rejected attempt must not cancel accepted work");
  first.release();
  second.release();
  third.release();
});
