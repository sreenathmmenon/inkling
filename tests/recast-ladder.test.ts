import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRungCandidate,
  createDeterministicSafetyRecast,
  pruneBehaviorPatchesForWorld,
  RECAST_RUNG_ORDER,
} from "../runner/recast-ladder.js";
import { runPlaytest } from "../services/solve/src/playtest.js";
import { createPlayContract } from "../packages/runtime/src/play-contract.js";
import { createPlatformerPlan } from "../packages/runtime/src/platformer-layout.js";
import { findProjectRoot, loadJson } from "../runner/spec.js";
import type { BehaviorPatch, GameSpec, PlaytestReport } from "../runner/types.js";

const root = findProjectRoot();
const JUNGLE = loadJson<GameSpec>(root, "tests/fixtures/jungle-explorer-p2.json");

function report(overrides: Partial<PlaytestReport>): PlaytestReport {
  return { reached_goal: false, first_blocker: null, time_to_win: null, seed: 42, visited: [], ...overrides };
}

function baseSpec(): GameSpec {
  return {
    primary_genre: "platformer", genre_confidence: 1, mood: null,
    hero: { id: "hero", name: "Hero", bbox: [0.05, 0.52, 0.15, 0.72], style_ref: "ink-hero" },
    entities: [
      { id: "floor", role: "platform", bbox: [0, 0.72, 1, 0.8], behavior: "static", linked_to: null, style_ref: "ink-floor" },
      { id: "spike", role: "hazard", bbox: [0.45, 0.6, 0.55, 0.7], behavior: "static", linked_to: null, style_ref: "red-spike" },
      { id: "gem", role: "collectible", bbox: [0.5, 0.2, 0.56, 0.26], behavior: "static", linked_to: null, style_ref: "green-gem" },
      { id: "snake", role: "enemy", bbox: [0.6, 0.62, 0.7, 0.7], behavior: "patrol", linked_to: null, style_ref: "snake-ink" },
      { id: "finish", role: "goal", bbox: [0.85, 0.52, 0.95, 0.72], behavior: "static", linked_to: null, style_ref: "ink-flag" },
    ],
    goal: { kind: "reach_goal", target_id: "finish" },
    rules: { lives: 3, difficulty_hint: "normal", modifiers: [] },
    palette: ["#000000"], assumptions: [], flags: [],
  };
}

test("bounded adjustment nudges only the blocking hazard, within repair bounds", () => {
  const source = baseSpec();
  const candidate = buildRungCandidate(
    "bounded_adjustment",
    source,
    report({ first_blocker: "lives_exhausted:spike" }),
  );
  assert.ok(candidate);
  const spike = candidate.entities.find((entity) => entity.id === "spike");
  assert.deepEqual(spike?.bbox, [0.45, 0.65, 0.55, 0.75], "the hazard moves down by exactly 0.05");
  assert.equal(spike?.role, "hazard", "the hazard keeps its role");
  for (const entity of candidate.entities) {
    if (entity.id === "spike") continue;
    assert.deepEqual(entity, source.entities.find((other) => other.id === entity.id));
  }
  assert.deepEqual(candidate.hero, source.hero);
  assert.ok(candidate.flags.includes("p8_bounded_adjustment"));
  assert.equal(candidate.flags.includes("p8_safety_recast"), false);
});

test("a bounded adjustment keeps a faithful world eligible for faithful_ready", () => {
  const faithful = baseSpec();
  faithful.entities = faithful.entities.filter((entity) => entity.id !== "snake" && entity.id !== "gem");
  faithful.flags.push("p8_bounded_adjustment");
  assert.equal(createPlayContract(faithful).outcome, "faithful_ready");
  const relieved = structuredClone(faithful);
  relieved.flags.push("p8_optional_pickups");
  assert.equal(createPlayContract(relieved).outcome, "related_fallback");
});

test("reach support adds one synthetic one-way platform beneath the unreached target", () => {
  const source = baseSpec();
  const candidate = buildRungCandidate(
    "reach_support",
    source,
    report({ first_blocker: "playtest_timeout", visited: ["hero", "floor"] }),
  );
  assert.ok(candidate);
  assert.equal(candidate.entities.length, source.entities.length + 1);
  const support = candidate.entities.find((entity) => entity.id.startsWith("__inkling_p8_synthetic__"));
  assert.ok(support, "the support platform carries trusted synthetic provenance");
  assert.equal(support.role, "platform");
  const gem = source.entities.find((entity) => entity.id === "gem");
  const centerX = ((gem?.bbox[0] ?? 0) + (gem?.bbox[2] ?? 0)) / 2;
  assert.ok(Math.abs((support.bbox[0] + support.bbox[2]) / 2 - centerX) < 0.001, "support sits under the unreached pickup");
  for (const entity of source.entities) {
    assert.deepEqual(candidate.entities.find((other) => other.id === entity.id), entity, `${entity.id} is untouched`);
  }
  assert.ok(candidate.flags.includes("p8_reach_support"));
});

test("pickup relief demotes only unreached pickups and keeps reached ones collectible", () => {
  const source = baseSpec();
  source.entities.push({ id: "gem_low", role: "collectible", bbox: [0.3, 0.64, 0.36, 0.7], behavior: "static", linked_to: null, style_ref: "blue-gem" });
  const candidate = buildRungCandidate(
    "pickup_relief",
    source,
    report({ first_blocker: "playtest_timeout", visited: ["hero", "floor", "gem_low"] }),
  );
  assert.ok(candidate);
  assert.equal(candidate.entities.find((entity) => entity.id === "gem")?.role, "decoration");
  assert.equal(candidate.entities.find((entity) => entity.id === "gem_low")?.role, "collectible");
  assert.equal(candidate.entities.find((entity) => entity.id === "snake")?.behavior, "patrol", "dynamic entities survive relief");
  assert.deepEqual(candidate.entities.find((entity) => entity.id === "gem")?.bbox, source.entities.find((entity) => entity.id === "gem")?.bbox, "demoted art keeps its drawn position");
  assert.equal(candidate.goal.target_id, "finish", "the drawn goal stays the goal");
  assert.ok(candidate.flags.includes("p8_optional_pickups"));
});

test("objective fallback changes only the goal", () => {
  const source = baseSpec();
  const candidate = buildRungCandidate("objective_fallback", source, report({}));
  assert.ok(candidate);
  assert.equal(candidate.goal.kind, "collect_all");
  assert.deepEqual(candidate.entities, source.entities);
  assert.ok(candidate.flags.includes("collect_all_fallback"));

  const noPickups = baseSpec();
  noPickups.entities = noPickups.entities.filter((entity) => entity.role !== "collectible");
  const survive = buildRungCandidate("objective_fallback", noPickups, report({}));
  assert.equal(survive?.goal.kind, "survive");
  assert.ok(survive?.flags.includes("survive_mode_fallback"));
});

test("the guarded floor keeps drawn surfaces landable and drawn pickups collectible", () => {
  const source = baseSpec();
  const candidate = buildRungCandidate("guarded_floor", source, report({}));
  assert.ok(candidate);
  const floor = candidate.entities.find((entity) => entity.id === "floor");
  assert.equal(floor?.role, "platform", "drawn surfaces stay collidable");
  assert.deepEqual(floor?.bbox, [0, 0.72, 1, 0.8]);
  assert.equal(floor?.style_ref, "ink-floor");
  assert.equal(candidate.entities.find((entity) => entity.id === "gem")?.role, "collectible");
  assert.equal(candidate.entities.find((entity) => entity.id === "spike")?.role, "decoration");
  assert.equal(candidate.entities.find((entity) => entity.id === "snake")?.role, "decoration");
  const synthetic = candidate.entities.filter((entity) => entity.id.startsWith("__inkling_p8_synthetic__"));
  assert.equal(synthetic.length, 2, "synthetic ground and finish are appended");
  assert.ok(candidate.flags.includes("p8_guarded_floor"));

  const plan = createPlatformerPlan(candidate);
  assert.ok(
    plan.platforms.some((platform) => platform.id === "floor"),
    "the drawn surface is a real collision surface in the runtime plan",
  );
  assert.equal(runPlaytest(candidate).reached_goal, true, "the guarded floor is locally finishable here");
});

test("every rung is deterministic for the same input", () => {
  const source = baseSpec();
  const blocked = report({ first_blocker: "lives_exhausted:spike", visited: ["hero", "floor"] });
  for (const rung of RECAST_RUNG_ORDER) {
    const first = buildRungCandidate(rung, source, blocked);
    const second = buildRungCandidate(rung, source, blocked);
    assert.deepEqual(first, second, `${rung} must be deterministic`);
  }
});

test("behavior patches survive rungs that keep their entity intact and drop with demotion", () => {
  const source = baseSpec();
  const patches: BehaviorPatch[] = [
    { entityId: "snake", operation: { type: "create_file" } as BehaviorPatch["operation"], source: "code" },
  ];
  const fallbacks: Record<string, "static"> = { snake: "static" };

  const relief = buildRungCandidate("pickup_relief", source, report({ visited: ["hero", "floor"] }));
  assert.ok(relief);
  const kept = pruneBehaviorPatchesForWorld(patches, fallbacks, source, relief);
  assert.equal(kept.patches.length, 1, "the surviving patrol entity keeps its patch");
  assert.deepEqual(kept.fallbacks, { snake: "static" });

  const floor = buildRungCandidate("guarded_floor", source, report({}));
  assert.ok(floor);
  const dropped = pruneBehaviorPatchesForWorld(patches, fallbacks, source, floor);
  assert.equal(dropped.patches.length, 0, "a demoted entity's patch is dropped");
  assert.deepEqual(dropped.fallbacks, {});
  assert.deepEqual(dropped.removedEntityIds, ["snake"]);
});

test("jungle-explorer certifies at pickup relief with its drawn world intact", () => {
  const raw = structuredClone(JUNGLE);
  const rawReport = runPlaytest(raw);
  assert.equal(rawReport.reached_goal, false, "the fixture reproduces the corpus blocker");

  assert.equal(buildRungCandidate("bounded_adjustment", raw, rawReport), null);
  const supported = buildRungCandidate("reach_support", raw, rawReport);
  assert.ok(supported);
  assert.equal(runPlaytest(supported).reached_goal, false, "one support platform is not enough here");

  const relieved = buildRungCandidate("pickup_relief", raw, rawReport);
  assert.ok(relieved);
  assert.equal(runPlaytest(relieved).reached_goal, true, "pickup relief makes the drawn world finishable");

  const byId = new Map(raw.entities.map((entity) => [entity.id, entity]));
  for (const entity of relieved.entities) {
    const original = byId.get(entity.id);
    assert.ok(original);
    assert.deepEqual(entity.bbox, original.bbox, `${entity.id} keeps its drawn position`);
    assert.equal(entity.style_ref, original.style_ref, `${entity.id} keeps its stroke identity`);
    if (original.role !== "collectible") {
      assert.equal(entity.role, original.role, `${entity.id} keeps its role`);
      assert.equal(entity.behavior, original.behavior, `${entity.id} keeps its behavior`);
    }
  }
  assert.equal(relieved.goal.target_id, raw.goal.target_id, "the drawn temple goal stays the goal");
  assert.ok(
    relieved.entities.some((entity) => entity.role === "enemy" && entity.behavior === "patrol"),
    "the patrol snakes stay patrol enemies",
  );
  assert.ok(relieved.flags.includes("p8_optional_pickups"));
  assert.equal(relieved.flags.includes("p8_safety_recast"), false, "no full recast for this drawing");
  assert.equal(createPlayContract(relieved).outcome, "related_fallback");

  const fullFloor = createDeterministicSafetyRecast(raw);
  const relievedPlayable = relieved.entities.filter((entity) => entity.role !== "decoration").length;
  const fullFloorPlayable = fullFloor.entities.filter(
    (entity) => entity.role !== "decoration" && !entity.id.startsWith("__inkling_p8_synthetic__"),
  ).length;
  assert.ok(
    relievedPlayable > fullFloorPlayable,
    "the ladder keeps strictly more of the child's drawing playable than the old full recast",
  );
});
