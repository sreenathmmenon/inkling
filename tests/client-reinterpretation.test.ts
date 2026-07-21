import assert from "node:assert/strict";
import test from "node:test";

import {
  activeReinterpretationVariant,
  beginReinterpretationRequest,
  createReinterpretation,
  offeredGenre,
  reinterpretationArrived,
  reinterpretationFailed,
  toggleReinterpretation,
} from "../apps/client/src/reinterpretation.js";

const ORIGINAL = { document: { id: "original" }, certification: "certified" as const };
const ALTERNATE = { document: { id: "alternate" }, certification: "certified" as const };

test("no machine exists without a genuine alternate — a unanimous read offers no fake choice", () => {
  assert.equal(createReinterpretation("platformer", "platformer", ORIGINAL), null);
  assert.equal(createReinterpretation("platformer", null, ORIGINAL), null);
  assert.equal(createReinterpretation("platformer", undefined, ORIGINAL), null);
  assert.equal(createReinterpretation("platformer", "", ORIGINAL), null);
  assert.equal(createReinterpretation(undefined, "maze", ORIGINAL), null);
});

test("the toggle path: offer, request, arrival, then instant swaps in both directions", () => {
  let machine = createReinterpretation("platformer", "maze", ORIGINAL);
  assert.ok(machine);
  assert.equal(machine.phase, "offer");
  assert.equal(offeredGenre(machine), "maze", "the control offers the other way first");
  assert.equal(activeReinterpretationVariant(machine).document, ORIGINAL.document);

  machine = beginReinterpretationRequest(machine);
  assert.equal(machine.phase, "requesting");
  assert.equal(
    toggleReinterpretation(machine),
    machine,
    "no toggle can happen while the round-trip is in flight",
  );

  const arrived = reinterpretationArrived(machine, ALTERNATE, "maze");
  assert.ok(arrived);
  machine = arrived;
  assert.equal(machine.phase, "offer");
  assert.equal(machine.active, "alternate", "the child lands in the version they asked for");
  assert.equal(activeReinterpretationVariant(machine).document, ALTERNATE.document);
  assert.equal(offeredGenre(machine), "platformer", "the control now offers the way back");

  machine = toggleReinterpretation(machine);
  assert.equal(machine.active, "original");
  assert.equal(activeReinterpretationVariant(machine).document, ORIGINAL.document);
  assert.equal(offeredGenre(machine), "maze");

  machine = toggleReinterpretation(machine);
  assert.equal(machine.active, "alternate", "both directions keep working with no further requests");
  assert.equal(
    beginReinterpretationRequest(machine),
    machine,
    "a cached pair never re-requests the server",
  );
});

test("each variant keeps its own certification outcome across swaps", () => {
  const unverifiedAlternate = { document: { id: "alt" }, certification: "unverified" as const };
  let machine = createReinterpretation("runner", "slingshot", ORIGINAL);
  assert.ok(machine);
  machine = beginReinterpretationRequest(machine);
  const arrived = reinterpretationArrived(machine, unverifiedAlternate, "slingshot");
  assert.ok(arrived);
  assert.equal(activeReinterpretationVariant(arrived).certification, "unverified");
  const back = toggleReinterpretation(arrived);
  assert.equal(activeReinterpretationVariant(back).certification, "certified");
});

test("a failed round-trip restores the offer and keeps the child's current game", () => {
  let machine = createReinterpretation("platformer", "maze", ORIGINAL);
  assert.ok(machine);
  machine = beginReinterpretationRequest(machine);
  machine = reinterpretationFailed(machine);
  assert.equal(machine.phase, "offer", "the child can try again");
  assert.equal(machine.alternate, null);
  assert.equal(activeReinterpretationVariant(machine).document, ORIGINAL.document);
});

test("a certification ladder that collapses the alternate onto the original withdraws the offer", () => {
  let machine = createReinterpretation("platformer", "maze", ORIGINAL);
  assert.ok(machine);
  machine = beginReinterpretationRequest(machine);
  assert.equal(
    reinterpretationArrived(machine, ALTERNATE, "platformer"),
    null,
    "the same game twice is not an honest choice",
  );
  assert.equal(reinterpretationArrived(machine, ALTERNATE, undefined), null);
});

test("an arrival certified as a third genre is offered under its true name", () => {
  let machine = createReinterpretation("runner", "maze", ORIGINAL);
  assert.ok(machine);
  machine = beginReinterpretationRequest(machine);
  const arrived = reinterpretationArrived(machine, ALTERNATE, "platformer");
  assert.ok(arrived, "a genuinely different certified genre still counts");
  assert.equal(arrived.alternateGenre, "platformer", "the label follows what was actually certified");
  assert.equal(offeredGenre(arrived), "runner");
});
