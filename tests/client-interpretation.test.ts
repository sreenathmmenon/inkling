import assert from "node:assert/strict";
import test from "node:test";

import {
  appendCorrection,
  assumptionChips,
  certificationNotice,
  interpretationNoteText,
  simplificationNotice,
} from "../apps/client/src/interpretation-status.js";

const INTERNAL_TERMS = /recast|ladder|pipeline|solvab|contract|fallback|deterministic|lane a|p8|p2\b/i;

test("every simplification path has child-safe copy free of internal vocabulary", () => {
  const flags = [
    "p8_bounded_adjustment",
    "p8_reach_support",
    "p8_optional_pickups",
    "collect_all_fallback",
    "survive_mode_fallback",
    "p8_guarded_floor",
    "p8_safety_recast",
    "deterministic_fallback",
    "lane_a_fallback",
  ];
  for (const flag of flags) {
    const notice = simplificationNotice([flag]);
    assert.ok(notice, `${flag} must produce a message — no degradation path is silent`);
    assert.equal(INTERNAL_TERMS.test(notice), false, `${flag} copy leaks internal terms: ${notice}`);
    assert.ok(notice.length <= 90, "copy stays short enough for a child to read");
  }
  assert.equal(simplificationNotice([]), null, "an untouched world needs no simplification message");
  assert.equal(simplificationNotice(["genre_uncertain"]), null);
});

test("the largest simplification wins when several rungs fired", () => {
  const notice = simplificationNotice(["p8_bounded_adjustment", "p8_safety_recast"]);
  assert.equal(notice, "I made this one a little simpler so you can finish it!");
});

test("an unverified game is announced instead of silently appearing normal", () => {
  const notice = certificationNotice("unverified");
  assert.ok(notice);
  assert.equal(INTERNAL_TERMS.test(notice), false);
  assert.equal(certificationNotice("certified"), null);
  assert.equal(certificationNotice("not_applicable"), null);

  const combined = interpretationNoteText("faithful_ready", [], "unverified");
  assert.ok(combined.includes("double-checking"));
  const silentIsImpossible = interpretationNoteText(undefined, ["p8_optional_pickups"], "certified");
  assert.ok(silentIsImpossible.includes("scenery"));
  assert.equal(interpretationNoteText("faithful_ready", [], "certified"), "");
});

test("assumption chips show only child-readable guesses, capped and deduplicated", () => {
  const chips = assumptionChips([
    "The explorer is the hero.",
    "The explorer is the hero.",
    "Lane A recast the mechanics to its deterministic finishable floor after the solvability repair loop.",
    "  ",
    "The snakes patrol their ledges.",
    "The six floating gems are optional collectibles.",
    "I used three lives because no life count is written.",
    "A fifth guess that should be cut by the cap.",
  ]);
  assert.deepEqual(chips, [
    "The explorer is the hero.",
    "The snakes patrol their ledges.",
    "The six floating gems are optional collectibles.",
    "I used three lives because no life count is written.",
  ]);
  for (const chip of chips) assert.equal(INTERNAL_TERMS.test(chip), false);
});

test("corrections accumulate bounded, deduplicated, and trimmed", () => {
  const first = appendCorrection([], "The red blob is an enemy.");
  assert.deepEqual(first, ["The red blob is an enemy."]);
  assert.deepEqual(appendCorrection(first, "The red blob is an enemy."), first);
  assert.deepEqual(appendCorrection(first, "   "), first);
  let corrections: string[] = [];
  for (let index = 0; index < 9; index += 1) {
    corrections = appendCorrection(corrections, `guess ${index}`);
  }
  assert.equal(corrections.length, 6, "corrections stay within the service bound");
  assert.equal(corrections[0], "guess 3", "oldest corrections drop first");
  const long = appendCorrection([], "x".repeat(500));
  assert.equal(long[0]?.length, 240);
});
