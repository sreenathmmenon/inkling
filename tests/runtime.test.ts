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
  attachRuntimeTraceReport,
  fitArtworkWithin,
  resolvePlayableGame,
} from "../packages/runtime/src/artwork.js";
import { createTouchControlLayout } from "../packages/runtime/src/platformer-controls.js";
import {
  ONE_WAY_PLATFORM_COLLISION,
  PLATFORMER_PHYSICS,
} from "../packages/runtime/src/platformer-physics.js";
import { createObjectiveContract } from "../packages/runtime/src/objective-contract.js";
import {
  CELEBRATION_POINTS,
  feedbackCueFor,
  type GameplayFeedbackEvent,
} from "../packages/runtime/src/feedback-contract.js";
import { createCoachingContract, createRecoveryCue } from "../packages/runtime/src/coaching-contract.js";
import { GAME_CONTRACTS } from "../packages/runtime/src/game-contract.js";
import { createPlayContract } from "../packages/runtime/src/play-contract.js";
import {
  surfaceJumpVelocity,
  surfaceVelocityX,
} from "../packages/runtime/src/platformer-materials.js";
import { keyDoorRelationships } from "../packages/runtime/src/relationship-contract.js";
import { type GameSpec } from "../runner/types.js";
import { findProjectRoot, loadJson } from "../runner/spec.js";
import {
  dominantSurfaceColor,
  dominantSurfaceShare,
  fallbackWorldColor,
  featherSurfaceEdges,
  isolateBorderConnectedBackdrop,
  softlyIsolateLocalBackdrop,
  softlyRemoveKnownBackdrop,
  softenWorldColor,
} from "../packages/runtime/src/artwork-rendering.js";
import {
  artworkHaloForWorldColor,
  boundedCueAnchor,
  friendlyObjectiveLabel,
  INKLING_CUE,
  INKLING_FONT_FAMILY,
} from "../packages/runtime/src/presentation-contract.js";

const liveSpec = loadJson<unknown>(findProjectRoot(), "examples/live-scan-gamespec.json");

test("Lane A presentation cues are deterministic, bounded, and separate from source art", () => {
  assert.match(INKLING_FONT_FAMILY, /Nunito/);
  assert.notEqual(INKLING_CUE.violet, INKLING_CUE.coral);
  assert.deepEqual(
    boundedCueAnchor(2, 3, 28, WORLD_WIDTH, WORLD_HEIGHT),
    { x: 56, y: 38, originY: 0 },
  );
  assert.deepEqual(
    boundedCueAnchor(WORLD_WIDTH - 2, 500, 538, WORLD_WIDTH, WORLD_HEIGHT),
    { x: WORLD_WIDTH - 56, y: 490, originY: 1 },
  );
  const darkHalo = artworkHaloForWorldColor(0x111526);
  const lightHalo = artworkHaloForWorldColor(0xfffbf4);
  assert.equal(darkHalo.color, INKLING_CUE.paper);
  assert.equal(lightHalo.color, INKLING_CUE.violetDeep);
  assert.ok(darkHalo.alpha <= 0.15 && lightHalo.alpha <= 0.15, "legibility backplates stay subtle");
  assert.equal(friendlyObjectiveLabel("FINISH"), "Goal");
  assert.equal(friendlyObjectiveLabel("STAY SAFE"), "Stay safe");
});

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

  assert.equal(first.goalTrigger.y, first.goal.y);
  assert.ok(first.goalTrigger.width >= first.goal.width);
  assert.ok(first.goalTrigger.height >= first.goal.height);
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
  assert.deepEqual(plan.requiredCollectibleIds, [], "reach_goal never gates on bonus collectibles");
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

test("an explicit key-door relationship compiles into one faithful deterministic state machine", () => {
  const spec: GameSpec = {
    primary_genre: "platformer", genre_confidence: 1, mood: null,
    hero: { id: "hero", name: "Hero", bbox: [0.08, 0.6, 0.15, 0.75], style_ref: "source" },
    entities: [
      { id: "floor", role: "platform", bbox: [0, 0.78, 1, 0.86], behavior: "static", linked_to: null, style_ref: "source" },
      { id: "key", role: "key", bbox: [0.3, 0.66, 0.35, 0.74], behavior: "static", linked_to: "door", style_ref: "source" },
      { id: "door", role: "door", bbox: [0.55, 0.5, 0.61, 0.78], behavior: "static", linked_to: "key", style_ref: "source" },
      { id: "finish", role: "goal", bbox: [0.86, 0.62, 0.93, 0.78], behavior: "static", linked_to: null, style_ref: "source" },
    ],
    goal: { kind: "reach_goal", target_id: "finish" },
    rules: { lives: 3, difficulty_hint: "chill", modifiers: [] },
    palette: ["#ffffff", "#222222"], assumptions: [], flags: [],
  };
  assert.deepEqual(keyDoorRelationships(spec), [{ kind: "key_opens_door", keyId: "key", doorId: "door" }]);
  const plan = createPlatformerPlan(spec);
  assert.deepEqual(plan.requiredCollectibleIds, ["key"]);
  assert.equal(plan.doors[0]?.id, "door");
  assert.equal(createObjectiveContract(plan).headline, "Unlock the way");
  assert.equal(createPlayContract(spec).outcome, "faithful_ready");
});

test("surface mechanics are deterministic and semantically distinct", () => {
  assert.equal(surfaceVelocityX(0, 1, "platform"), PLATFORMER_PHYSICS.moveVelocityX);
  const firstIceFrame = surfaceVelocityX(0, 1, "ice");
  assert.equal(firstIceFrame, PLATFORMER_PHYSICS.iceAccelerationPerFrame);
  assert.ok(surfaceVelocityX(firstIceFrame, 0, "ice") > 0, "ice must coast after release");
  assert.ok(surfaceJumpVelocity("launchpad") < surfaceJumpVelocity("platform"));
  assert.ok(surfaceJumpVelocity("cloud") > surfaceJumpVelocity("platform"));
});

test("world-sized regions stay environmental instead of becoming unavoidable hazards", () => {
  const spec = structuredClone(liveSpec) as GameSpec;
  spec.entities.push({
    id: "world_zone", role: "water", bbox: [0.01, 0.45, 0.99, 0.98], behavior: "static", style_ref: "source",
  });
  const plan = createPlatformerPlan(spec);
  assert.equal(plan.hazards.some((entity) => entity.id === "world_zone"), false);
  assert.equal(plan.waterVolumes.some((entity) => entity.id === "world_zone"), true);
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
  const genres = Object.keys(GAME_CONTRACTS) as Array<keyof typeof GAME_CONTRACTS>;
  assert.deepEqual(
    [...genres].sort(),
    ["maze", "platformer", "roller", "runner", "slingshot"],
    "the engine's genre truth table must match the honest GameSpec vocabulary exactly",
  );
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

test("PlayContract distinguishes faithful execution from a merely playable fallback", () => {
  const platformer: GameSpec = {
    primary_genre: "platformer", genre_confidence: 1, mood: null,
    hero: { id: "hero", name: "Hero", bbox: [0.1, 0.5, 0.2, 0.7], style_ref: "source" },
    entities: [
      { id: "floor", role: "platform", bbox: [0, 0.72, 1, 0.8], behavior: "static", linked_to: null, style_ref: "source" },
      { id: "finish", role: "goal", bbox: [0.8, 0.5, 0.9, 0.7], behavior: "static", linked_to: null, style_ref: "source" },
    ],
    goal: { kind: "reach_goal", target_id: "finish" },
    rules: { lives: 3, difficulty_hint: "normal", modifiers: [] },
    palette: ["#ffffff"], assumptions: [], flags: [],
  };
  const faithful = createPlayContract(platformer);
  assert.equal(faithful.outcome, "faithful_ready");
  assert.deepEqual(faithful.unsupportedCapabilities, []);

  const safetyRecast = structuredClone(platformer);
  safetyRecast.flags.push("p8_safety_recast");
  assert.equal(
    createPlayContract(safetyRecast).outcome,
    "related_fallback",
    "a certified mechanical recast must never be presented as the original idea faithfully executed",
  );

  const maze = structuredClone(platformer);
  maze.primary_genre = "maze";
  const recast = createPlayContract(maze);
  assert.equal(recast.outcome, "needs_recast");
  assert.ok(recast.blockers.includes("maze_topology_has_no_finishable_route"));
  assert.ok(recast.supportedCapabilities.includes("maze_collision_topology"));

  const runner = structuredClone(platformer);
  runner.primary_genre = "runner";
  const runnerContract = createPlayContract(runner);
  assert.equal(runnerContract.outcome, "faithful_ready");
  assert.equal(runnerContract.templateId, "lane-a-runner-v1");
  assert.ok(runnerContract.supportedCapabilities.includes("manual_progress_input"));
  assert.ok(runnerContract.supportedCapabilities.includes("runner_route_topology"));

  const candidate = createPlayableGameDocument(platformer, undefined, undefined, {
    playtestReport: { reached_goal: true, first_blocker: null, time_to_win: 3, seed: 1, visited: ["hero", "finish"] },
    solvability: { verdict: "ready" },
  });
  assert.equal(
    resolvePlayableGame(candidate).readinessOutcome,
    "related_fallback",
    "capability fit alone must not claim faithful Ready",
  );
  const certified = attachRuntimeTraceReport(candidate, {
    format: "inkling-runtime-trace-report-v1",
    contractFormat: faithful.format,
    templateId: faithful.templateId,
    runtimeVersion: faithful.runtimeVersion,
    valid: true,
    blockers: [],
    inputAccepted: true,
    reachedTerminalState: true,
    finalStatus: "won",
    finalFrame: 180,
  });
  assert.equal(resolvePlayableGame(certified).readinessOutcome, "faithful_ready");
});

test("maze readiness comes from clearance-aware drawn wall topology", () => {
  const maze: GameSpec = {
    primary_genre: "maze", genre_confidence: 1, mood: null,
    hero: { id: "hero", name: "Hero", bbox: [0.08, 0.12, 0.15, 0.25], style_ref: "source" },
    entities: [
      { id: "wall", role: "platform", bbox: [0.47, 0, 0.53, 0.68], behavior: "static", linked_to: null, style_ref: "source" },
      { id: "finish", role: "goal", bbox: [0.82, 0.12, 0.9, 0.25], behavior: "static", linked_to: null, style_ref: "source" },
    ],
    goal: { kind: "reach_goal", target_id: "finish" },
    rules: { lives: 3, difficulty_hint: "normal", modifiers: [] },
    palette: ["#ffffff", "#222222"], assumptions: [], flags: [],
  };
  const plan = createPlatformerPlan(maze);
  const contract = createPlayContract(maze);

  assert.deepEqual(plan.mazeCollisionWalls.map((wall) => wall.id), ["wall"]);
  assert.equal(plan.mazeTopologyFallback, false);
  assert.equal(contract.templateId, "lane-a-maze-v1");
  assert.equal(contract.outcome, "faithful_ready");

  maze.entities[0]!.bbox = [0.47, 0, 0.53, 1];
  const sealed = createPlatformerPlan(maze);
  assert.equal(sealed.mazeTopologyFallback, true);
  assert.deepEqual(sealed.mazeCollisionWalls, []);
  assert.equal(createPlayContract(maze).outcome, "needs_recast");
});

test("PlayContract rejects false-ready structural goals and unimplemented declared behavior", () => {
  const game: GameSpec = {
    primary_genre: "platformer", genre_confidence: 1, mood: null,
    hero: { id: "hero", name: "Hero", bbox: [0.1, 0.5, 0.2, 0.7], style_ref: "source" },
    entities: [
      { id: "enemy", role: "enemy", bbox: [0.5, 0.5, 0.6, 0.7], behavior: "patrol", linked_to: null, style_ref: "source" },
    ],
    goal: { kind: "collect_all", target_id: null },
    rules: { lives: 3, difficulty_hint: "normal", modifiers: ["move faster after every pickup"] },
    palette: ["#ffffff"], assumptions: [], flags: [],
  };
  const contract = createPlayContract(game);
  assert.equal(contract.outcome, "needs_recast");
  assert.ok(contract.blockers.includes("collect_all_has_no_collectible_entities"));
  assert.ok(contract.unsupportedCapabilities.includes("dynamic_entity_behavior"));
  assert.ok(contract.unsupportedCapabilities.includes("declared_rule_modifiers"));
});

test("PlayContract rejects safety-floor-only routes and invalid relationship graphs", () => {
  const game: GameSpec = {
    primary_genre: "platformer", genre_confidence: 1, mood: null,
    hero: { id: "hero", name: "Hero", bbox: [0.1, 0.5, 0.2, 0.7], style_ref: "source" },
    entities: [
      { id: "switch", role: "collectible", bbox: [0.4, 0.5, 0.5, 0.6], behavior: "static", linked_to: "door", style_ref: "source" },
      { id: "door", role: "door", bbox: [0.6, 0.4, 0.7, 0.7], behavior: "static", linked_to: "switch", style_ref: "source" },
      { id: "finish", role: "goal", bbox: [0.8, 0.5, 0.9, 0.7], behavior: "static", linked_to: null, style_ref: "source" },
    ],
    goal: { kind: "reach_goal", target_id: "finish" },
    rules: { lives: 3, difficulty_hint: "normal", modifiers: [] },
    palette: ["#ffffff"], assumptions: [], flags: [],
  };
  const contract = createPlayContract(game);
  assert.equal(contract.outcome, "needs_recast");
  assert.equal(createPlatformerPlan(game).contract.movement, "free");
  assert.ok(contract.unsupportedCapabilities.includes("declared_genre_movement"));
  assert.ok(contract.blockers.includes("linked_entity_cycle"));
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

test("water remains a swim volume instead of silently becoming damage", () => {
  const game = structuredClone(liveSpec) as GameSpec;
  game.primary_genre = "roller";
  game.hero.bbox = [0.08, 0.46, 0.21, 0.66];
  game.entities = [
    { id: "water", role: "water", bbox: [0.03, 0.55, 0.32, 0.72], behavior: "static", linked_to: null, style_ref: "source" },
    { id: "goal", role: "goal", bbox: [0.83, 0.21, 0.93, 0.43], behavior: "static", linked_to: null, style_ref: "source" },
  ];
  game.goal = { kind: "reach_goal", target_id: "goal" };

  const plan = createPlatformerPlan(game);

  assert.ok(Math.abs(plan.hero.x - 139.2) < 0.001);
  assert.ok(Math.abs(plan.hero.y - 302.4) < 0.001);
  assert.equal(plan.hazards.length, 0);
  assert.equal(plan.waterVolumes[0]?.id, "water");
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

test("gameplay feedback is deterministic, semantic, and reduced-motion safe", () => {
  const pickup: GameplayFeedbackEvent = {
    kind: "pickup", elapsedMs: 1_250, entityId: "entity_a", required: true,
  };
  assert.deepEqual(feedbackCueFor(pickup, false), feedbackCueFor(pickup, false));
  assert.equal(feedbackCueFor(pickup, false).label, "Found!");
  assert.equal(feedbackCueFor({ ...pickup, required: false }, false).label, "Bonus!");
  assert.equal(feedbackCueFor(pickup, true).motion, "none");
  assert.notEqual(feedbackCueFor(pickup, false).motion, "none");
  assert.equal(feedbackCueFor({ ...pickup, kind: "goal_blocked" }, false).label, "Find everything first");
  assert.equal(CELEBRATION_POINTS.length, 12);
  assert.equal(new Set(CELEBRATION_POINTS.map((point) => point.join(","))).size, CELEBRATION_POINTS.length);
  assert.ok(CELEBRATION_POINTS.every(([x, y]) => Math.abs(x) < 0.5 && Math.abs(y) < 0.5));
});

test("one projectile action can cross the entire deterministic world", () => {
  const maximumTravel = PLATFORMER_PHYSICS.projectileVelocity *
    PLATFORMER_PHYSICS.projectileLifetimeMs / 1_000;
  assert.ok(maximumTravel >= Math.hypot(WORLD_WIDTH, WORLD_HEIGHT));
});

test("first-use coaching derives only from engine contracts and objective geometry", () => {
  const base: GameSpec = {
    primary_genre: "platformer", genre_confidence: 1, mood: null,
    hero: { id: "hero", name: "Hero", bbox: [0.1, 0.5, 0.2, 0.7], style_ref: "source" },
    entities: [
      { id: "entity_a", role: "collectible", bbox: [0.5, 0.5, 0.55, 0.6], behavior: "static", style_ref: "source" },
      { id: "target", role: "goal", bbox: [0.8, 0.5, 0.9, 0.7], behavior: "static", style_ref: "source" },
    ],
    goal: { kind: "reach_goal", target_id: "target" },
    rules: { lives: 3, difficulty_hint: "normal", modifiers: [] },
    palette: ["#ffffff"], assumptions: [], flags: [],
  };
  const ground = createCoachingContract(createPlatformerPlan(base));
  assert.equal(ground.firstControl, "right");
  assert.equal(ground.objectiveLabel, "FINISH", "reach coaching points at the finish, not at bonus items");

  const collectAll = structuredClone(base);
  collectAll.goal = { kind: "collect_all", target_id: null };
  const collecting = createCoachingContract(createPlatformerPlan(collectAll));
  assert.equal(collecting.objectiveTarget?.id, "entity_a");
  assert.equal(collecting.objectiveLabel, "FIND");

  const free = structuredClone(base);
  free.primary_genre = "maze";
  free.entities[0]!.bbox = [0.12, 0.05, 0.2, 0.15];
  free.entities[1]!.bbox = [0.12, 0.05, 0.2, 0.15];
  const upward = createCoachingContract(createPlatformerPlan(free));
  assert.equal(upward.firstControl, "jump");

  const runner = structuredClone(base);
  runner.primary_genre = "runner";
  runner.entities.unshift({
    id: "support", role: "platform", bbox: [0.05, 0.71, 0.45, 0.78], behavior: "static", style_ref: "source",
  });
  assert.equal(
    createCoachingContract(createPlatformerPlan(runner)).firstControl,
    "right",
    "the first runner action must explicitly start progress",
  );

  const slingshot = structuredClone(base);
  slingshot.primary_genre = "slingshot";
  slingshot.goal = { kind: "defeat_boss", target_id: "target" };
  assert.equal(createCoachingContract(createPlatformerPlan(slingshot)).firstControl, "action");
});

test("recovery coaching never suggests a control the active game does not expose", () => {
  assert.equal(createRecoveryCue("four_way", 0, 100), "Try ↓ toward the glow");
  assert.equal(createRecoveryCue("four_way", 0, -100), "Try ↑ toward the glow");
  assert.equal(createRecoveryCue("side", 0, 100), "Try moving, then jump toward the glow");
  assert.equal(createRecoveryCue("side", 0, -100), "Try jump ↑ toward the glow");
  assert.equal(createRecoveryCue("side", -100, 0), "Try ← and jump toward the glow");
  assert.doesNotMatch(createRecoveryCue("side", 0, 100), /↓/);
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
    finishRequired: true,
  });

  const collectPlan = { ...reachPlan, goalKind: "collect_all" };
  const collectObjective = createObjectiveContract(collectPlan);
  assert.equal(collectObjective.headline, "Find everything");
  assert.equal(collectObjective.counterLabel, "Found");
  assert.equal(collectObjective.requiredTotal, 1);
  assert.equal(collectObjective.finishRequired, false);
  assert.doesNotMatch(JSON.stringify(collectObjective), /star|carrot|rocket|collectible/i);
});

test("reach means reach: pickups are bonus, collect_all gathers, keys gate", () => {
  const spec: GameSpec = {
    primary_genre: "roller", genre_confidence: 1, mood: null,
    hero: { id: "hero", name: "Hero", bbox: [0.05, 0.45, 0.15, 0.6], style_ref: "source" },
    entities: [
      { id: "near_route_1", role: "collectible", bbox: [0.25, 0.48, 0.3, 0.55], behavior: "static", linked_to: null, style_ref: "source" },
      { id: "large_detour", role: "collectible", bbox: [0.42, 0.05, 0.47, 0.12], behavior: "static", linked_to: null, style_ref: "source" },
      { id: "near_route_2", role: "collectible", bbox: [0.55, 0.5, 0.6, 0.57], behavior: "static", linked_to: null, style_ref: "source" },
      { id: "near_route_3", role: "collectible", bbox: [0.7, 0.47, 0.75, 0.54], behavior: "static", linked_to: null, style_ref: "source" },
      { id: "detour_2", role: "key", bbox: [0.72, 0.15, 0.77, 0.22], behavior: "static", linked_to: null, style_ref: "source" },
      { id: "detour_3", role: "collectible", bbox: [0.2, 0.82, 0.25, 0.89], behavior: "static", linked_to: null, style_ref: "source" },
      { id: "finish", role: "goal", bbox: [0.86, 0.46, 0.94, 0.6], behavior: "static", linked_to: null, style_ref: "source" },
    ],
    goal: { kind: "reach_goal", target_id: "finish" },
    rules: { lives: 3, difficulty_hint: "normal", modifiers: [] },
    palette: ["#ffffff"], assumptions: [], flags: [],
  };

  const first = createPlatformerPlan(spec);
  const second = createPlatformerPlan(spec);
  assert.deepEqual(first.requiredCollectibleIds, second.requiredCollectibleIds);
  assert.deepEqual(first.requiredCollectibleIds, [], "reach_goal gates on nothing but the goal");
  assert.equal(first.collectibles.length, 6, "bonus pickups stay collectible");
  const reachObjective = createObjectiveContract(first);
  assert.equal(reachObjective.requiredTotal, 0);
  assert.equal(reachObjective.optionalTotal, 6);
  assert.equal(reachObjective.counterLabel, "Bonus");

  const gatherEverything = structuredClone(spec);
  gatherEverything.goal = { kind: "collect_all", target_id: null };
  const collectPlan = createPlatformerPlan(gatherEverything);
  assert.deepEqual(collectPlan.requiredCollectibleIds, [
    "near_route_1", "large_detour", "near_route_2", "near_route_3", "detour_2", "detour_3",
  ], "collect_all still requires every drawn pickup");
  assert.equal(createObjectiveContract(collectPlan).requiredTotal, 6);

  const keyGated = structuredClone(spec);
  keyGated.entities.find((entity) => entity.id === "detour_2")!.linked_to = "route_door";
  keyGated.entities.push({
    id: "route_door", role: "door", bbox: [0.8, 0.4, 0.84, 0.6], behavior: "static", linked_to: null, style_ref: "source",
  });
  const keyPlan = createPlatformerPlan(keyGated);
  assert.deepEqual(keyPlan.requiredCollectibleIds, ["detour_2"], "a drawn key with a drawn door still gates");
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
  assert.deepEqual(artwork.entityCrops.hero?.map((value) => Number(value.toFixed(3))), [0.088, 0.17, 0.312, 0.73]);
  assert.deepEqual(artwork.entityCrops.goal?.map((value) => Number(value.toFixed(3))), [0.694, 0.376, 0.806, 0.824]);
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
  assert.equal(saved.readinessEvidence?.playContract.outcome, "related_fallback");
  assert.ok(saved.readinessEvidence?.playContract.unsupportedCapabilities.includes("declared_genre_movement"));
  assert.equal(resolvePlayableGame(gameSpec).artwork, undefined);
  assert.equal(resolvePlayableGame({
    format: "inkling-playable-game-v1",
    gameSpec,
    artwork: { format: "inkling-artwork-v1", sourceDataUrl: "https://example.com/art.png", entityCrops: {} },
  }).artwork, undefined, "Lane A must not fetch arbitrary artwork URLs");
});

test("original artwork always fits without changing its aspect ratio", () => {
  const wide = fitArtworkWithin(400, 100, 120, 120);
  assert.deepEqual(wide, { width: 120, height: 30 });
  const tall = fitArtworkWithin(100, 400, 120, 120);
  assert.deepEqual(tall, { width: 30, height: 120 });
  assert.equal(wide.width / wide.height, 4);
  assert.equal(tall.width / tall.height, 0.25);
});

function pixelSurface(width: number, height: number, color: [number, number, number]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    data[offset] = color[0];
    data[offset + 1] = color[1];
    data[offset + 2] = color[2];
    data[offset + 3] = 255;
  }
  return data;
}

test("artwork isolation supports arbitrary uniform substrate colors without deleting enclosed strokes", () => {
  const width = 20;
  const height = 20;
  const data = pixelSurface(width, height, [42, 92, 178]);
  for (let y = 6; y < 14; y += 1) {
    for (let x = 6; x < 14; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = 255;
      data[offset + 1] = 210;
      data[offset + 2] = 32;
    }
  }
  const result = isolateBorderConnectedBackdrop({ data, width, height });
  assert.equal(result.isolated, true);
  assert.equal(data[3], 0, "colored substrate at the crop border should become transparent");
  assert.equal(data[((10 * width + 10) * 4) + 3], 255, "the enclosed child mark must remain opaque");
});

test("artwork isolation uses a dominant border instead of requiring four identical corners", () => {
  const width = 24;
  const height = 16;
  const data = pixelSurface(width, height, [248, 246, 239]);
  for (let x = 0; x < 5; x += 1) {
    for (const y of [0, height - 1]) {
      const offset = (y * width + x) * 4;
      data[offset] = 16;
      data[offset + 1] = 62;
      data[offset + 2] = 164;
    }
  }
  const result = isolateBorderConnectedBackdrop({ data, width, height });
  assert.equal(result.isolated, true);
  assert.ok(result.removedPixels > width * height * 0.7);
});

test("world backdrop comes from image dominance or a neutral palette color, never palette position", () => {
  const width = 16;
  const height = 16;
  const data = pixelSurface(width, height, [250, 248, 242]);
  for (let y = 5; y < 11; y += 1) {
    for (let x = 5; x < 11; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = 255;
      data[offset + 1] = 216;
      data[offset + 2] = 0;
    }
  }
  assert.equal(dominantSurfaceColor({ data, width, height }), 0xfaf8f2);
  assert.ok(dominantSurfaceShare({ data, width, height }) > 0.8);
  assert.equal(fallbackWorldColor(["#ffd800", "#ff8800", "#ffffff"]), 0xffffff);
  assert.equal(fallbackWorldColor(["#ffd800", "#ff8800"]), 0xf7f4ff);
  assert.equal(softenWorldColor(0xd2cdc4), 0xeeece9);
});

test("uncertain hero crops feather only their outside edge", () => {
  const data = pixelSurface(10, 10, [30, 60, 90]);
  featherSurfaceEdges({ data, width: 10, height: 10 });
  assert.equal(data[3], 0);
  assert.equal(data[(5 * 10 + 5) * 4 + 3], 255);
  assert.deepEqual([...data.slice((5 * 10 + 5) * 4, (5 * 10 + 5) * 4 + 3)], [30, 60, 90]);
});

test("textured local substrate can be removed without changing retained mark colors", () => {
  const width = 30;
  const height = 24;
  const data = pixelSurface(width, height, [132, 102, 76]);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const variation = (x * 7 + y * 11) % 15;
      data[offset] = 125 + variation;
      data[offset + 1] = 95 + variation;
      data[offset + 2] = 69 + variation;
    }
  }
  for (let y = 7; y < 18; y += 1) {
    for (let x = 9; x < 22; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = 30;
      data[offset + 1] = 24;
      data[offset + 2] = 20;
    }
  }
  assert.equal(softlyIsolateLocalBackdrop({ data, width, height }), true);
  assert.equal(data[3], 0);
  const center = (12 * width + 15) * 4;
  assert.deepEqual([...data.slice(center, center + 3)], [30, 24, 20]);
  assert.equal(data[center + 3], 255);
});

test("known substrate cleanup removes enclosed photo pockets but retains distinct ink", () => {
  const width = 20;
  const height = 20;
  const data = pixelSurface(width, height, [136, 106, 80]);
  for (let y = 4; y < 16; y += 1) {
    for (let x = 4; x < 16; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = 32;
      data[offset + 1] = 25;
      data[offset + 2] = 21;
    }
  }
  for (let y = 8; y < 12; y += 1) {
    for (let x = 8; x < 12; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = 140;
      data[offset + 1] = 110;
      data[offset + 2] = 84;
    }
  }
  assert.equal(softlyRemoveKnownBackdrop({ data, width, height }, 0x886a50), true);
  assert.equal(data[3], 0);
  assert.equal(data[(9 * width + 9) * 4 + 3], 0);
  assert.equal(data[(6 * width + 6) * 4 + 3], 255);
});

test("a drawn trail keeps the runner automatic and starts the run on the route", () => {
  const trailRunner: GameSpec = {
    primary_genre: "runner", genre_confidence: 1, mood: null,
    // The hero is drawn floating beside the trail, not pixel-perfectly on it —
    // the shape of the three corpus drawings that downgraded to free.
    hero: { id: "hero", name: "Runner", bbox: [0.05, 0.2, 0.15, 0.4], style_ref: "source" },
    entities: [
      { id: "trail", role: "platform", bbox: [0.2, 0.55, 0.95, 0.68], behavior: "static", linked_to: null, style_ref: "finger-paint" },
      { id: "finish", role: "goal", bbox: [0.86, 0.35, 0.94, 0.55], behavior: "static", linked_to: null, style_ref: "source" },
    ],
    goal: { kind: "reach_goal", target_id: "finish" },
    rules: { lives: 3, difficulty_hint: "normal", modifiers: [] },
    palette: ["#ffffff"], assumptions: [], flags: [],
  };
  const plan = createPlatformerPlan(trailRunner);
  assert.equal(plan.contract.movement, "auto_ground", "a drawn trail is legitimate runner support");
  const trail = plan.platforms.find((platform) => platform.id === "trail");
  assert.ok(trail);
  assert.ok(
    Math.abs(plan.hero.x - (trail.x - trail.width / 2)) <= plan.hero.width,
    "the spawn relocates to the start of the drawn route",
  );
  const contract = createPlayContract(trailRunner);
  assert.equal(contract.requiredCapabilities.includes("declared_genre_movement"), false);
  assert.equal(contract.outcome, "faithful_ready", "a trail runner is faithful-capable again");
  

  const surfaceless = structuredClone(trailRunner);
  surfaceless.entities = surfaceless.entities.filter((entity) => entity.id !== "trail");
  const downgraded = createPlatformerPlan(surfaceless);
  assert.equal(downgraded.contract.movement, "free", "no drawn surface at all still downgrades honestly");
});
