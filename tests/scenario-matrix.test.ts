import assert from "node:assert/strict";
import test from "node:test";

import { createPlatformerPlan } from "../packages/runtime/src/platformer-layout.js";
import { createPlayContract } from "../packages/runtime/src/play-contract.js";
import type { GameSpec } from "../runner/types.js";
import { runPlaytest } from "../services/solve/src/playtest.js";

const GENRES = [
  "platformer",
  "maze",
  "runner",
  "roller",
  "shooter",
  "slingshot",
  "tower_defense",
] as const;

function scenario(index: number): GameSpec {
  const primaryGenre = GENRES[index % GENRES.length]!;
  const groundMovement = primaryGenre === "platformer" || primaryGenre === "runner";
  const entities: GameSpec["entities"] = [];
  let heroBox: [number, number, number, number] = [0.07, 0.58, 0.14, 0.72];
  let goalBox: [number, number, number, number] = [0.84, 0.55, 0.92, 0.74];

  if (groundMovement) {
    const surfaceRoles = ["platform", "ice", "cloud", "launchpad"];
    entities.push({
      id: `surface_${index}`,
      role: surfaceRoles[index % surfaceRoles.length]!,
      bbox: [0, 0.74, 1, 0.82],
      behavior: "static",
      linked_to: null,
      style_ref: "source",
    });
    if (index % 3 === 0) {
      entities.push({
        id: `hazard_${index}`,
        role: "hazard",
        bbox: [0.43, 0.66, 0.5, 0.74],
        behavior: "static",
        linked_to: null,
        style_ref: "source",
      });
    }
  } else {
    heroBox = [0.07, 0.12, 0.15, 0.26];
    goalBox = [0.82, 0.7, 0.91, 0.84];
    if (primaryGenre === "maze") {
      goalBox = [0.82, 0.12, 0.91, 0.26];
      entities.push({
        id: `wall_${index}`,
        role: "platform",
        bbox: index % 2 === 0 ? [0.47, 0, 0.53, 0.67] : [0.47, 0.33, 0.53, 1],
        behavior: "static",
        linked_to: null,
        style_ref: "source",
      });
    } else if (index % 3 === 0) {
      entities.push({
        id: `hazard_${index}`,
        role: "hazard",
        bbox: [0.43, 0.25, 0.56, 0.68],
        behavior: "static",
        linked_to: null,
        style_ref: "source",
      });
    }
  }

  const collectAll = index % 5 === 0 && primaryGenre !== "shooter";
  if (collectAll) {
    entities.push({
      id: `item_${index}`,
      role: "collectible",
      bbox: groundMovement ? [0.66, 0.62, 0.71, 0.72] : [0.7, 0.7, 0.76, 0.79],
      behavior: "static",
      linked_to: null,
      style_ref: "source",
    });
  } else {
    entities.push({
      id: `goal_${index}`,
      role: "goal",
      bbox: goalBox,
      behavior: "static",
      linked_to: null,
      style_ref: "source",
    });
  }

  return {
    primary_genre: primaryGenre,
    genre_confidence: 0.75 + (index % 25) / 100,
    mood: index % 2 === 0 ? "playful" : null,
    hero: {
      id: `hero_${index}`,
      name: `Drawn hero ${index}`,
      bbox: heroBox,
      style_ref: "source",
    },
    entities,
    goal: collectAll
      ? { kind: "collect_all", target_id: null }
      : { kind: "reach_goal", target_id: `goal_${index}` },
    rules: {
      lives: 1 + index % 5,
      difficulty_hint: index % 2 === 0 ? "chill" : "normal",
      modifiers: [],
    },
    palette: ["#fffaf0", "#211c38", "#ffd556", "#7bc47f", "#d84343"],
    assumptions: [],
    flags: [],
  };
}

test("120 schema-driven customer worlds stay deterministic, bounded, and finishable", () => {
  for (let index = 0; index < 120; index += 1) {
    const gameSpec = scenario(index);
    const firstPlan = createPlatformerPlan(gameSpec);
    const secondPlan = createPlatformerPlan(gameSpec);
    assert.deepEqual(firstPlan, secondPlan, `scenario ${index}: plan changed with no input change`);

    for (const entity of [
      firstPlan.hero,
      firstPlan.goal,
      ...firstPlan.platforms,
      ...firstPlan.doors,
      ...firstPlan.hazards,
      ...firstPlan.collectibles,
    ]) {
      assert.ok(
        [entity.x, entity.y, entity.width, entity.height].every(Number.isFinite),
        `scenario ${index}/${entity.id}: non-finite geometry`,
      );
      assert.ok(entity.width > 0 && entity.height > 0, `scenario ${index}/${entity.id}: empty geometry`);
    }

    const firstReport = runPlaytest(gameSpec, 42);
    const secondReport = runPlaytest(gameSpec, 42);
    assert.deepEqual(firstReport, secondReport, `scenario ${index}: P8 is not deterministic`);
    assert.equal(
      firstReport.reached_goal,
      true,
      `scenario ${index}/${gameSpec.primary_genre}: ${firstReport.first_blocker}`,
    );

    const contract = createPlayContract(gameSpec);
    if (contract.outcome === "faithful_ready") {
      assert.deepEqual(contract.unsupportedCapabilities, [], `scenario ${index}: false faithful claim`);
      assert.deepEqual(contract.blockers, [], `scenario ${index}: faithful world has blockers`);
    }
  }
});

test("100 malformed geometry variants fall closed into finite deterministic Lane A plans", () => {
  const unusual: unknown[] = [
    null,
    {},
    { hero: null, entities: [] },
    { primary_genre: "platformer", hero: {}, entities: [], goal: {}, rules: {} },
  ];
  for (let index = unusual.length; index < 100; index += 1) {
    unusual.push({
      primary_genre: index % 2 ? "platformer" : "unknown",
      hero: { id: `h${index}`, name: "H", bbox: [Infinity, -index, Number.NaN, index], style_ref: "source" },
      entities: [{ id: `e${index}`, role: "platform", bbox: [2, 1, -1, 0], behavior: "static", style_ref: "source" }],
      goal: { kind: "reach_goal", target_id: `e${index}` },
      rules: { lives: -index, difficulty_hint: "normal", modifiers: [] },
    });
  }

  for (const [index, value] of unusual.entries()) {
    const first = createPlatformerPlan(value);
    assert.deepEqual(first, createPlatformerPlan(value), `malformed ${index}: nondeterministic fallback`);
    assert.ok([first.hero.x, first.hero.y, first.goal.x, first.goal.y].every(Number.isFinite));
    assert.ok(first.lives >= 1 && first.lives <= 9);
  }
});
