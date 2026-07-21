import assert from "node:assert/strict";
import test from "node:test";

import {
  attachMaterialize,
  MATERIALIZE_STAGES,
  materializeTreatment,
  type MaterializeHost,
} from "../apps/client/src/materialize.js";

test("materialize progress is earned only by real pipeline stage arrivals", () => {
  assert.deepEqual(MATERIALIZE_STAGES, ["checking", "understanding", "animating", "testing"]);
  assert.deepEqual(materializeTreatment("checking"), { stage: "checking", progress: 0.25 });
  assert.deepEqual(materializeTreatment("understanding"), { stage: "understanding", progress: 0.5 });
  assert.deepEqual(materializeTreatment("animating"), { stage: "animating", progress: 0.75 });
  assert.deepEqual(materializeTreatment("testing"), { stage: "testing", progress: 1 });
  // Unknown or malformed SSE stages never invent progress.
  assert.equal(materializeTreatment(""), null);
  assert.equal(materializeTreatment("celebrating"), null);
  assert.equal(materializeTreatment("CHECKING"), null);
});

test("materialize never repeats a stage and never moves backwards", () => {
  // A duplicated SSE event is a no-op, not a re-animation.
  assert.equal(materializeTreatment("understanding", 0.5), null);
  // An out-of-order arrival can never un-lift the drawing.
  assert.equal(materializeTreatment("checking", 0.75), null);
  // Later stages still advance from any earlier progress.
  assert.equal(materializeTreatment("testing", 0.75)?.progress, 1);
  // Progress is monotonic across the declared stage order.
  let progress = 0;
  for (const stage of MATERIALIZE_STAGES) {
    const treatment = materializeTreatment(stage, progress);
    assert.ok(treatment && treatment.progress > progress, `stage ${stage} did not advance`);
    progress = treatment.progress;
  }
  assert.equal(progress, 1);
});

test("attachMaterialize applies the stage treatment and rests without celebration", () => {
  const properties = new Map<string, string>();
  const attributes = new Map<string, string>();
  const host: MaterializeHost = {
    style: {
      setProperty: (name, value) => void properties.set(name, value),
      removeProperty: (name) => void properties.delete(name),
    },
    setAttribute: (name, value) => void attributes.set(name, value),
    removeAttribute: (name) => void attributes.delete(name),
  };
  const controller = attachMaterialize(host);
  assert.equal(controller.progress(), 0);

  controller.stageReached("checking");
  assert.equal(properties.get("--materialize"), "0.25");
  assert.equal(attributes.get("data-materialize-stage"), "checking");

  // Stale, repeated, and unknown arrivals leave the treatment untouched.
  controller.stageReached("checking");
  controller.stageReached("not-a-stage");
  assert.equal(properties.get("--materialize"), "0.25");

  controller.stageReached("animating");
  assert.equal(properties.get("--materialize"), "0.75");
  assert.equal(attributes.get("data-materialize-stage"), "animating");
  controller.stageReached("understanding");
  assert.equal(properties.get("--materialize"), "0.75", "out-of-order stage moved progress backwards");
  assert.equal(controller.progress(), 0.75);

  // Reset (cancel, failure, or hand-off to the game) fully rests the page —
  // no terminal flourish is ever written by the loading treatment.
  controller.reset();
  assert.equal(properties.size, 0);
  assert.equal(attributes.size, 0);
  assert.equal(controller.progress(), 0);

  // A later generation starts from rest again.
  controller.stageReached("checking");
  assert.equal(properties.get("--materialize"), "0.25");
});
