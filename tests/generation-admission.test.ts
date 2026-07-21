import assert from "node:assert/strict";
import test from "node:test";

import { GenerationAdmissionController } from "../services/gen/src/generation-admission.js";
import { MAX_IMAGE_BYTES, MAX_REQUEST_BYTES } from "../services/gen/src/image-limits.js";
import { createGenerationAdmission } from "../services/gen/src/server-admission.js";

function accepted(result: ReturnType<GenerationAdmissionController["begin"]>) {
  assert.equal(result.accepted, true);
  if (!result.accepted) throw new Error("expected admission");
  return result.lease;
}

test("one upload size contract: the body cap is derived from the single image cap", () => {
  const base64ImageBytes = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
  assert.ok(
    MAX_REQUEST_BYTES > base64ImageBytes,
    "a maximum-size legal image must fit inside its JSON upload body",
  );
  assert.ok(
    MAX_REQUEST_BYTES <= base64ImageBytes + 2 * 1024 * 1024,
    "the body cap allows only a bounded envelope beyond the encoded image",
  );
});

test("dev and production servers share one admission policy source", () => {
  const admission = createGenerationAdmission();
  assert.ok(admission instanceof GenerationAdmissionController);
  // Shared limits: 4 concurrent generations per process. The fifth distinct
  // session must be refused as busy on any server built from this module.
  const sessions = ["a", "b", "c", "d"].map((key) => accepted(admission.begin(`session-${key}`)));
  const fifth = admission.begin("session-e");
  assert.equal(fifth.accepted, false);
  if (!fifth.accepted) assert.equal(fifth.reason, "busy");
  for (const lease of sessions) lease.release();
});

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
