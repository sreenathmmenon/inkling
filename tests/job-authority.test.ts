import assert from "node:assert/strict";
import test from "node:test";

import { LatestGenerationJobAuthority } from "../services/gen/src/job-authority.js";

test("newest generation owns a session and older work is aborted", () => {
  const authority = new LatestGenerationJobAuthority();
  const first = authority.begin("anonymous-session");
  assert.equal(first.replacedOlderJob, false);
  assert.equal(first.isLatest(), true);

  const second = authority.begin("anonymous-session");
  assert.equal(second.replacedOlderJob, true);
  assert.equal(first.controller.signal.aborted, true);
  assert.equal(first.isLatest(), false);
  assert.equal(second.isLatest(), true);

  // An old finally block cannot delete the newer lease.
  first.release();
  assert.equal(authority.has("anonymous-session"), true);
  second.release();
  assert.equal(authority.has("anonymous-session"), false);
});

test("generation authority is isolated between anonymous sessions", () => {
  const authority = new LatestGenerationJobAuthority();
  const first = authority.begin("session-a");
  const second = authority.begin("session-b");
  assert.equal(first.controller.signal.aborted, false);
  assert.equal(second.controller.signal.aborted, false);
});

