import assert from "node:assert/strict";
import test from "node:test";

import {
  BEHAVIOR_TRACK_FORMAT,
  isBehaviorMotionTrack,
  MAX_TRACK_FRAMES,
  MIN_TRACK_PEAK_OFFSET,
  parseBehaviorTracks,
  TRACK_ANIMATABLE_ROLES,
  TRACK_DT,
  trackOffsetAt,
  type BehaviorMotionTrack,
} from "../packages/runtime/src/behavior-track.js";
import { validateBehaviorOperation } from "../packages/sdk/src/validator.js";
import { createPlatformerPlan } from "../packages/runtime/src/platformer-layout.js";
import { createPlayContract } from "../packages/runtime/src/play-contract.js";
import {
  createPlayableGameDocument,
  resolvePlayableGame,
} from "../packages/runtime/src/artwork.js";
import { runPlaytest } from "../services/solve/src/playtest.js";
import type { GameSpec } from "../runner/types.js";

function track(entityId: string, offsets: Array<[number, number]>): BehaviorMotionTrack {
  return { format: BEHAVIOR_TRACK_FORMAT, entityId, dt: TRACK_DT, offsets };
}

function patrolSpec(): GameSpec {
  return {
    primary_genre: "platformer", genre_confidence: 1, mood: null,
    hero: { id: "hero", name: "Hero", bbox: [0.05, 0.52, 0.15, 0.72], style_ref: "ink" },
    entities: [
      { id: "floor", role: "platform", bbox: [0, 0.72, 1, 0.8], behavior: "static", linked_to: null, style_ref: "ink" },
      { id: "walker", role: "enemy", bbox: [0.45, 0.6, 0.55, 0.7], behavior: "patrol", linked_to: null, style_ref: "ink" },
      { id: "finish", role: "goal", bbox: [0.85, 0.52, 0.95, 0.72], behavior: "static", linked_to: null, style_ref: "ink" },
    ],
    goal: { kind: "reach_goal", target_id: "finish" },
    rules: { lives: 3, difficulty_hint: "normal", modifiers: [] },
    palette: ["#000000"], assumptions: [], flags: [],
  };
}

const PATROL_MODULE_DIFF = [
  "+import { defineBehavior } from \"@inkling/sdk\";",
  "+defineBehavior({",
  "+  id: \"walker\",",
  "+  onUpdate(dt, ctx) {",
  "+    ctx.velocity(Math.sin(ctx.time * 2) * 80, 0);",
  "+  },",
  "+});",
].join("\n");

test("track validation is strictly bounded", () => {
  assert.equal(isBehaviorMotionTrack(track("walker", [[20, 0]])), true);
  assert.equal(isBehaviorMotionTrack(track("walker", [])), false, "empty tracks are meaningless");
  assert.equal(
    isBehaviorMotionTrack(track("walker", [[MIN_TRACK_PEAK_OFFSET, 0]])),
    true,
    "the perceptibility threshold is inclusive",
  );
  assert.equal(
    isBehaviorMotionTrack(track("walker", [[MIN_TRACK_PEAK_OFFSET - 0.1, 0]])),
    false,
    "sub-perceptible motion is a static claim wearing a dynamic label",
  );
  assert.equal(
    isBehaviorMotionTrack(track("walker", [[0.1, 0], [-0.1, 0]])),
    false,
    "the 0.1px jitter case that motivated the threshold is rejected",
  );
  assert.equal(
    isBehaviorMotionTrack(track("walker", Array.from({ length: MAX_TRACK_FRAMES + 1 }, () => [0, 0] as [number, number]))),
    false,
    "over-length tracks are rejected",
  );
  assert.equal(isBehaviorMotionTrack(track("walker", [[Number.NaN, 0]])), false);
  assert.equal(isBehaviorMotionTrack(track("walker", [[9999, 0]])), false, "offsets outside the world are rejected");
  assert.equal(isBehaviorMotionTrack({ ...track("walker", [[20, 20]]), dt: 1 / 30 }), false, "a foreign timestep breaks determinism");
  assert.deepEqual(trackOffsetAt(track("walker", [[15, 20], [30, 40]]), 0), [15, 20]);
  assert.deepEqual(trackOffsetAt(track("walker", [[15, 20], [30, 40]]), 5), [30, 40], "tracks loop past their horizon");
  const parsed = parseBehaviorTracks({
    walker: track("walker", [[20, 0]]),
    impostor: track("someone_else", [[20, 0]]),
    junk: { format: "wrong" },
  });
  assert.deepEqual(Object.keys(parsed), ["walker"], "id mismatches and junk are stripped");
});

test("the sandbox certifies a real patrol module into a bounded deterministic track", async () => {
  const operation = {
    type: "create_file",
    path: "behaviors/walker.ts",
    diff: PATROL_MODULE_DIFF,
  } as Parameters<typeof validateBehaviorOperation>[0];
  const first = await validateBehaviorOperation(operation, "walker");
  const second = await validateBehaviorOperation(operation, "walker");
  assert.equal(first.valid, true, `module must validate: ${first.errors.join(",")}`);
  assert.ok(first.patch, "a valid module yields a patch");
  assert.ok(first.track, "a moving module yields a certified track");
  assert.equal(isBehaviorMotionTrack(first.track), true, "the captured track passes strict validation");
  assert.equal(first.track.entityId, "walker");
  assert.equal(first.track.offsets.length, MAX_TRACK_FRAMES);
  assert.ok(first.track.offsets.some(([x]) => x !== 0), "the patrol actually moves");
  assert.deepEqual(first.track, second.track, "sandbox capture is deterministic given the seed");
});

test("tracks attach only to animatable drawn roles in the plan", () => {
  const spec = patrolSpec();
  const walkerTrack = track("walker", [[20, 0], [-20, 0]]);
  const plan = createPlatformerPlan(spec, { walker: walkerTrack });
  const walker = plan.hazards.find((entity) => entity.id === "walker");
  assert.deepEqual(walker?.track, walkerTrack, "the enemy carries its certified track");

  assert.equal(TRACK_ANIMATABLE_ROLES.has("collectible"), false);
  const decorated = patrolSpec();
  const gemEntity = decorated.entities.find((entity) => entity.id === "walker");
  if (gemEntity) gemEntity.role = "collectible";
  const gemPlan = createPlatformerPlan(decorated, { walker: walkerTrack });
  const planned = [...gemPlan.hazards, ...gemPlan.collectibles].find((entity) => entity.id === "walker");
  assert.equal(planned?.track, undefined, "a non-animatable role never carries motion");
});

test("the analytic playtester genuinely accounts for certified motion", () => {
  const spec: GameSpec = {
    primary_genre: "maze", genre_confidence: 1, mood: null,
    hero: { id: "hero", name: "Mouse", bbox: [0.06, 0.44, 0.14, 0.56], style_ref: "ink" },
    entities: [
      { id: "wall_top", role: "platform", bbox: [0.3, 0.0, 0.36, 0.42], behavior: "static", linked_to: null, style_ref: "ink" },
      { id: "wall_bottom", role: "platform", bbox: [0.3, 0.58, 0.36, 1.0], behavior: "static", linked_to: null, style_ref: "ink" },
      { id: "lurker", role: "hazard", bbox: [0.45, 0.08, 0.53, 0.2], behavior: "patrol", linked_to: null, style_ref: "ink" },
      { id: "finish", role: "goal", bbox: [0.8, 0.44, 0.9, 0.56], behavior: "static", linked_to: null, style_ref: "ink" },
    ],
    goal: { kind: "reach_goal", target_id: "finish" },
    rules: { lives: 1, difficulty_hint: "normal", modifiers: [] },
    palette: ["#000000"], assumptions: [], flags: [],
  };
  // Statically the lurker waits far off the corridor and the maze passes.
  assert.equal(runPlaytest(spec).reached_goal, true);
  // The certified track parks it in the only corridor: the same level must
  // now fail honestly — moving entities genuinely change solvability.
  const ambush = track("lurker", [[-154, 194]]);
  const blocked = runPlaytest(spec, { lurker: ambush });
  assert.equal(blocked.reached_goal, false, "a blocking track must fail the playtest");
  assert.match(blocked.first_blocker ?? "", /lives_exhausted:lurker/);
  const rerun = runPlaytest(spec, { lurker: ambush });
  assert.deepEqual(blocked, rerun, "tracked playtests stay deterministic");
});

test("dynamic behavior counts as supported only when every dynamic entity is certified", () => {
  const spec = patrolSpec();
  const uncertified = createPlayContract(spec);
  assert.ok(uncertified.unsupportedCapabilities.includes("dynamic_entity_behavior"));
  assert.equal(uncertified.outcome, "related_fallback");

  const certified = createPlayContract(spec, { certifiedDynamicEntityIds: ["walker"] });
  assert.ok(certified.supportedCapabilities.includes("dynamic_entity_behavior"));
  assert.equal(certified.outcome, "faithful_ready", "a fully certified dynamic world can be faithful");

  const twoDynamic = patrolSpec();
  twoDynamic.entities.push({
    id: "floater", role: "decoration", bbox: [0.2, 0.2, 0.26, 0.26], behavior: "rise", linked_to: null, style_ref: "ink",
  });
  const partial = createPlayContract(twoDynamic, { certifiedDynamicEntityIds: ["walker"] });
  assert.ok(
    partial.unsupportedCapabilities.includes("dynamic_entity_behavior"),
    "one uncertified dynamic entity keeps the claim honest",
  );
});

test("certified tracks round-trip through the playable document", () => {
  const spec = patrolSpec();
  const walkerTrack = track("walker", [[12, 0], [-12, 0]]);
  const image = "data:image/png;base64,aGVsbG8=";
  const document = createPlayableGameDocument(spec, image, undefined, {
    playtestReport: runPlaytest(spec, { walker: walkerTrack }),
    solvability: { verdict: "ready" },
  }, { walker: walkerTrack });
  assert.deepEqual(document.behaviorTracks, { walker: walkerTrack });
  assert.equal(
    document.readinessEvidence?.playContract.supportedCapabilities.includes("dynamic_entity_behavior"),
    true,
    "the stored contract carries the certified-evidence decision",
  );
  const resolved = resolvePlayableGame(document);
  assert.deepEqual(resolved.behaviorTracks, { walker: walkerTrack });

  const tampered = structuredClone(document) as unknown as Record<string, unknown>;
  tampered.behaviorTracks = { walker: { format: "evil", offsets: [[99999, 0]] } };
  assert.deepEqual(
    resolvePlayableGame(tampered).behaviorTracks,
    {},
    "tampered tracks are stripped, never executed",
  );
});
