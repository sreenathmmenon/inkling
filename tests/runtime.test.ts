import assert from "node:assert/strict";
import test from "node:test";

import {
  createPlatformerPlan,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from "../packages/runtime/src/platformer-layout.js";
import {
  createArtworkManifest,
  createPlayableGameDocument,
  resolvePlayableGame,
} from "../packages/runtime/src/artwork.js";
import { createTouchControlLayout } from "../packages/runtime/src/platformer-controls.js";
import { ONE_WAY_PLATFORM_COLLISION } from "../packages/runtime/src/platformer-physics.js";
import { createObjectiveContract } from "../packages/runtime/src/objective-contract.js";
import { type GameSpec } from "../runner/types.js";
import { findProjectRoot, loadJson } from "../runner/spec.js";

const liveSpec = loadJson<unknown>(findProjectRoot(), "examples/live-scan-gamespec.json");

test("Lane A maps the live scan deterministically into a playable physics plan", () => {
  const first = createPlatformerPlan(liveSpec);
  const second = createPlatformerPlan(liveSpec);

  assert.deepEqual(first, second);
  assert.equal(first.lives, 3);
  assert.equal(first.hero.id, "hero_1");
  assert.equal(first.hero.styleRef, "thick-dark-outline-yellow-clock-doodle");
  assert.equal(first.hero.x, 168);
  assert.ok(first.platforms.some((platform) => platform.id === "ground_1"));
  assert.ok(first.platforms.some((platform) => platform.id === "lane_a_safety_floor"));
  assert.ok(first.hazards.some((hazard) => hazard.id === "enemy_1"));
  assert.equal(first.goal.id, "goal_1");

  const safetyFloor = first.platforms.find((platform) => platform.id === "lane_a_safety_floor");
  assert.ok(safetyFloor);
  const floorTop = safetyFloor.y - safetyFloor.height / 2;
  const triggerBottom = first.goalTrigger.y + first.goalTrigger.height / 2;
  assert.ok(triggerBottom >= floorTop, "goal trigger must remain reachable from the safety floor");
});

test("Lane A always supplies a complete offline fallback for invalid input", () => {
  const plan = createPlatformerPlan(null);

  assert.equal(plan.goalKind, "reach_goal");
  assert.ok(plan.lives >= 1);
  assert.ok(plan.hero.x > 0 && plan.hero.x < WORLD_WIDTH);
  assert.ok(plan.hero.y > 0 && plan.hero.y < WORLD_HEIGHT);
  assert.ok(plan.platforms.length >= 1);
  assert.ok(plan.goalTrigger.width >= plan.goal.width);
  assert.ok(plan.goalTrigger.height >= plan.goal.height);
});

test("Lane A preserves lives and categorizes platformer interactions", () => {
  const plan = createPlatformerPlan({
    primary_genre: "platformer",
    genre_confidence: 1,
    mood: "bold",
    hero: {
      id: "hero",
      name: "Test Hero",
      bbox: [0.05, 0.6, 0.12, 0.75],
      style_ref: "hero-strokes",
    },
    entities: [
      { id: "ground", role: "platform", bbox: [0, 0.8, 1, 0.86], behavior: "static", style_ref: "ground-strokes" },
      { id: "spike", role: "hazard", bbox: [0.3, 0.74, 0.36, 0.8], behavior: "static", style_ref: "spike-strokes" },
      { id: "star", role: "collectible", bbox: [0.5, 0.65, 0.55, 0.72], behavior: "static", style_ref: "star-strokes" },
      { id: "flag", role: "goal", bbox: [0.88, 0.65, 0.94, 0.8], behavior: "static", style_ref: "flag-strokes" },
    ],
    goal: { kind: "reach_goal", target_id: "flag" },
    rules: { lives: 7, difficulty_hint: "normal", modifiers: [] },
    palette: ["#ffffff", "#111111", "#ffff00"],
    assumptions: [],
    flags: [],
  });

  assert.equal(plan.lives, 7);
  assert.deepEqual(plan.hazards.map((entity) => entity.id), ["spike"]);
  assert.deepEqual(plan.collectibles.map((entity) => entity.id), ["star"]);
  assert.equal(plan.goal.id, "flag");
  assert.equal(plan.goal.styleRef, "flag-strokes");
});

test("ground Lane A treats keys as required items and places them on reachable surfaces", () => {
  const spec = structuredClone(liveSpec) as GameSpec;
  spec.entities.push({
    id: "key_high", role: "key", bbox: [0.45, 0.02, 0.49, 0.08], behavior: "static", style_ref: "source",
  });
  const plan = createPlatformerPlan(spec);
  const key = plan.collectibles.find((entity) => entity.id === "key_high");
  assert.ok(key);
  assert.ok(key.y > WORLD_HEIGHT / 2, "ground-game key must be normalized into the reachable play area");
});

test("world-sized regions stay environmental instead of becoming unavoidable hazards", () => {
  const spec = structuredClone(liveSpec) as GameSpec;
  spec.entities.push({
    id: "world_zone", role: "water", bbox: [0.01, 0.45, 0.99, 0.98], behavior: "static", style_ref: "source",
  });
  const plan = createPlatformerPlan(spec);
  assert.equal(plan.hazards.some((entity) => entity.id === "world_zone"), false);
});

test("Lane A honors a free-movement GameSpec instead of snapping it into a platformer", () => {
  const plan = createPlatformerPlan({
    primary_genre: "roller",
    genre_confidence: 1,
    mood: "spacey",
    hero: {
      id: "hero",
      name: "Drawn hero",
      bbox: [0.28, 0.16, 0.42, 0.36],
      style_ref: "child-pencil-hero",
    },
    entities: [{
      id: "moon",
      role: "goal",
      bbox: [0.72, 0.68, 0.84, 0.82],
      behavior: "static",
      style_ref: "blue-crayon-moon",
    }],
    goal: { kind: "reach_goal", target_id: "moon" },
    rules: { lives: 3, difficulty_hint: "chill", modifiers: [] },
    palette: ["#ffffff", "#111111", "#ffcc00"],
    assumptions: [],
    flags: [],
  });

  assert.equal(plan.contract.movement, "free");
  assert.equal(plan.hero.y, 140.4, "the hero stays at its drawn vertical position");
  assert.equal(plan.goal.y, 405, "the target keeps its drawn vertical position");
  assert.ok(
    Math.abs(plan.goalTrigger.height - 75.6) < 0.001,
    "free-movement goal is a local target, not a floor-wide strip",
  );
});

test("every authoritative genre resolves to a deterministic Lane A contract", () => {
  const genres = ["platformer", "maze", "runner", "roller", "shooter", "slingshot", "tower_defense"] as const;
  for (const primaryGenre of genres) {
    const plan = createPlatformerPlan({
      primary_genre: primaryGenre,
      genre_confidence: 1,
      mood: "playful",
      hero: { id: "hero", name: "Hero", bbox: [0.1, 0.2, 0.18, 0.34], style_ref: "source" },
      entities: [{ id: "goal", role: "goal", bbox: [0.75, 0.65, 0.84, 0.8], behavior: "static", linked_to: null, style_ref: "source" }],
      goal: { kind: "reach_goal", target_id: "goal" },
      rules: { lives: 3, difficulty_hint: "chill", modifiers: [] },
      palette: ["#ffffff"], assumptions: [], flags: [],
    });
    assert.equal(plan.contract.id, primaryGenre);
    assert.ok(plan.goalTrigger.width > 0);
  }
});

test("runner topology comes from drawn support geometry, not object names", () => {
  const unsupported: GameSpec = {
    primary_genre: "runner", genre_confidence: 1, mood: null,
    hero: { id: "hero", name: "Hero", bbox: [0.1, 0.4, 0.2, 0.55], style_ref: "source" },
    entities: [{ id: "goal", role: "goal", bbox: [0.8, 0.4, 0.9, 0.55], behavior: "static", style_ref: "source" }],
    goal: { kind: "reach_goal", target_id: "goal" },
    rules: { lives: 3, difficulty_hint: "normal", modifiers: [] },
    palette: ["#ffffff"], assumptions: [], flags: [],
  };
  assert.equal(createPlatformerPlan(unsupported).contract.movement, "free");
  unsupported.entities.unshift({
    id: "support", role: "platform", bbox: [0.05, 0.56, 0.4, 0.62], behavior: "static", style_ref: "source",
  });
  assert.equal(createPlatformerPlan(unsupported).contract.movement, "auto_ground");
});

test("free-movement Lane A moves an overlapping start to the nearest safe position", () => {
  const game = structuredClone(liveSpec) as GameSpec;
  game.primary_genre = "roller";
  game.hero.bbox = [0.08, 0.46, 0.21, 0.66];
  game.entities = [
    { id: "water", role: "water", bbox: [0.03, 0.55, 0.32, 0.72], behavior: "static", linked_to: null, style_ref: "source" },
    { id: "goal", role: "goal", bbox: [0.83, 0.21, 0.93, 0.43], behavior: "static", linked_to: null, style_ref: "source" },
  ];
  game.goal = { kind: "reach_goal", target_id: "goal" };

  const plan = createPlatformerPlan(game);

  assert.notDeepEqual([plan.hero.x, plan.hero.y], [139.2, 302.4]);
  const water = plan.hazards[0]!;
  assert.ok(
    Math.abs(plan.hero.x - water.x) * 2 >= plan.hero.width * plan.contract.colliderScale + water.width * 0.72 + 12 ||
    Math.abs(plan.hero.y - water.y) * 2 >= plan.hero.height * plan.contract.colliderScale + water.height * 0.72 + 12,
  );
});

test("touch controls keep a child-sized tap target without dominating desktop play", () => {
  const phone = createTouchControlLayout(360, 203);
  const desktop = createTouchControlLayout(1_495, 840);

  assert.ok(phone.size * (360 / WORLD_WIDTH) >= 48);
  assert.ok(desktop.size * (1_495 / WORLD_WIDTH) <= 72);
  assert.ok(phone.left[1] + phone.size / 2 < phone.right[1] - phone.size / 2);

  const portrait = createTouchControlLayout(390, 488, 432, 540);
  assert.ok(portrait.size * (390 / 432) >= 48);
  assert.ok(portrait.left[0] > 0);
  assert.ok(portrait.right[0] < 432);
});

test("all drawn platform shapes use the same one-way landing contract", () => {
  assert.deepEqual(ONE_WAY_PLATFORM_COLLISION, {
    up: true,
    down: false,
    left: false,
    right: false,
  });
});

test("objective copy and counters stay truthful without guessing drawing nouns", () => {
  const reachPlan = createPlatformerPlan({
    primary_genre: "platformer", genre_confidence: 1, mood: null,
    hero: { id: "hero", name: "Hero", bbox: [0.1, 0.5, 0.2, 0.7], style_ref: "source" },
    entities: [
      { id: "entity_1", role: "collectible", bbox: [0.4, 0.5, 0.45, 0.6], behavior: "static", linked_to: null, style_ref: "source" },
      { id: "entity_2", role: "goal", bbox: [0.8, 0.5, 0.9, 0.7], behavior: "static", linked_to: null, style_ref: "source" },
    ],
    goal: { kind: "reach_goal", target_id: "entity_2" },
    rules: { lives: 3, difficulty_hint: "normal", modifiers: [] },
    palette: ["#ffffff"], assumptions: [], flags: [],
  });
  assert.deepEqual(createObjectiveContract(reachPlan), {
    headline: "Reach the finish",
    instruction: "Reach the marked finish. Drawn items are a bonus.",
    counterLabel: "Bonus",
    requiredTotal: 0,
    optionalTotal: 1,
  });

  const collectPlan = { ...reachPlan, goalKind: "collect_all" };
  const collectObjective = createObjectiveContract(collectPlan);
  assert.equal(collectObjective.headline, "Find everything");
  assert.equal(collectObjective.counterLabel, "Found");
  assert.equal(collectObjective.requiredTotal, 1);
  assert.doesNotMatch(JSON.stringify(collectObjective), /star|carrot|rocket|collectible/i);
});

test("an empty collect-all contract falls back to a reachable finish instead of a dead end", () => {
  const plan = createPlatformerPlan({
    primary_genre: "platformer", genre_confidence: 1, mood: null,
    hero: { id: "hero", name: "Hero", bbox: [0.1, 0.5, 0.2, 0.7], style_ref: "source" },
    entities: [],
    goal: { kind: "collect_all", target_id: null },
    rules: { lives: 3, difficulty_hint: "normal", modifiers: [] },
    palette: ["#ffffff"], assumptions: [], flags: [],
  });
  assert.equal(plan.goalKind, "reach_goal");
  assert.equal(createObjectiveContract(plan).headline, "Reach the finish");
  assert.ok(plan.goalTrigger.width > 0 && plan.goalTrigger.height > 0);
});

test("a saved playable game carries only local original artwork and entity crops", () => {
  const gameSpec: GameSpec = {
    primary_genre: "platformer",
    genre_confidence: 1,
    mood: null,
    hero: { id: "hero", name: "Kid Hero", bbox: [0.1, 0.2, 0.3, 0.7], style_ref: "original" },
    entities: [{
      id: "goal",
      role: "goal",
      bbox: [0.7, 0.4, 0.8, 0.8],
      behavior: "static",
      linked_to: null,
      style_ref: "original",
    }],
    goal: { kind: "reach_goal", target_id: "goal" },
    rules: { lives: 3, difficulty_hint: "chill", modifiers: null },
    palette: ["#ffffff"],
    assumptions: [],
    flags: [],
  };
  const source = "data:image/png;base64,aGVsbG8=";
  const artwork = createArtworkManifest(gameSpec, source, {
    topology: "blob",
    tier: "squash_stretch_puppet",
    joints: [],
    animations: ["idle", "walk", "jump", "bounce"],
    style_ref: "original",
  });
  assert.deepEqual(artwork.entityCrops.hero, [0.1, 0.2, 0.3, 0.7]);
  assert.deepEqual(artwork.entityCrops.goal, [0.7, 0.4, 0.8, 0.8]);
  assert.deepEqual(artwork.heroRig?.animations, ["idle", "walk", "jump", "bounce"]);

  const saved = createPlayableGameDocument(gameSpec, source, artwork.heroRig && {
    topology: artwork.heroRig.topology,
    tier: artwork.heroRig.tier,
    joints: artwork.heroRig.joints.map((joint) => ({ name: joint.name, point: joint.point })),
    animations: artwork.heroRig.animations,
    style_ref: artwork.heroRig.styleRef,
  }, {
    playtestReport: { reached_goal: true, first_blocker: null, time_to_win: 4, seed: 1, visited: ["hero"] },
    solvability: { verdict: "ready" },
  });
  const resolved = resolvePlayableGame(saved);
  assert.equal(resolved.gameSpec, gameSpec);
  assert.equal(resolved.artwork?.sourceDataUrl, source);
  assert.equal(saved.readinessEvidence?.solvability.verdict, "ready");
  assert.equal(resolvePlayableGame(gameSpec).artwork, undefined);
  assert.equal(resolvePlayableGame({
    format: "inkling-playable-game-v1",
    gameSpec,
    artwork: { format: "inkling-artwork-v1", sourceDataUrl: "https://example.com/art.png", entityCrops: {} },
  }).artwork, undefined, "Lane A must not fetch arbitrary artwork URLs");
});
