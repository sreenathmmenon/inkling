import assert from "node:assert/strict";
import test from "node:test";

import {
  createLaunchState,
  LAUNCH_CONTRACT,
  launchVelocityForAim,
  resetLaunchShot,
  stepLaunchFrame,
  type LaunchInput,
  type LaunchWorld,
} from "../packages/runtime/src/launch-contract.js";
import { GAME_CONTRACTS } from "../packages/runtime/src/game-contract.js";
import { createPlatformerPlan } from "../packages/runtime/src/platformer-layout.js";
import { createCoachingContract } from "../packages/runtime/src/coaching-contract.js";
import { createPlayContract } from "../packages/runtime/src/play-contract.js";
import {
  runPlaytest,
  runPlaytestWithTrace,
} from "../services/solve/src/playtest.js";
import { validateRuntimeTrace } from "../services/solve/src/runtime-trace.js";
import type { RuntimeEvent } from "../packages/runtime/src/runtime-events.js";
import type { GameSpec } from "../runner/types.js";

const IDLE: LaunchInput = { left: false, right: false, jump: false, action: false };

function world(): LaunchWorld {
  return {
    heroWidth: 37,
    heroHeight: 43,
    platforms: [{ x: 480, y: 522, width: 960, height: 36 }],
  };
}

function slingshotFixture(): GameSpec {
  return {
    primary_genre: "slingshot", genre_confidence: 1, mood: null,
    hero: { id: "hero", name: "Hero", bbox: [0.08, 0.08, 0.15, 0.22], style_ref: "source" },
    entities: [
      { id: "floor", role: "platform", bbox: [0, 0.74, 1, 0.82], behavior: "static", linked_to: null, style_ref: "source" },
      { id: "flight_hazard", role: "hazard", bbox: [0.45, 0.66, 0.52, 0.74], behavior: "static", linked_to: null, style_ref: "source" },
      { id: "finish", role: "goal", bbox: [0.82, 0.55, 0.9, 0.74], behavior: "static", linked_to: null, style_ref: "source" },
    ],
    goal: { kind: "reach_goal", target_id: "finish" },
    rules: { lives: 3, difficulty_hint: "normal", modifiers: [] },
    palette: ["#ffffff"], assumptions: [], flags: [],
  };
}

test("slingshot resolves to a real launch contract, not a free-movement alias", () => {
  assert.equal(GAME_CONTRACTS.slingshot.movement, "launch");
  assert.equal(GAME_CONTRACTS.slingshot.touchControls, "side");
  assert.equal(GAME_CONTRACTS.slingshot.action, "contact");
  const plan = createPlatformerPlan(slingshotFixture());
  assert.equal(plan.contract.movement, "launch");
  assert.equal(
    createCoachingContract(plan).firstControl,
    "jump",
    "coaching must teach the fire control so every win is input-backed",
  );
});

test("aim taps are edge-triggered, quantized, and clamped to the shared range", () => {
  const state = createLaunchState(100, 200);
  assert.equal(state.phase, "aiming");
  assert.equal(state.aimDeg, LAUNCH_CONTRACT.initialAimDeg);

  for (let frame = 0; frame < 10; frame += 1) {
    stepLaunchFrame(state, { ...IDLE, left: true }, world());
  }
  assert.equal(state.aimDeg, LAUNCH_CONTRACT.initialAimDeg + LAUNCH_CONTRACT.aimStepDeg,
    "a held button is one step, not a sweep");
  stepLaunchFrame(state, IDLE, world());
  stepLaunchFrame(state, { ...IDLE, left: true }, world());
  assert.equal(state.aimDeg, LAUNCH_CONTRACT.initialAimDeg + 2 * LAUNCH_CONTRACT.aimStepDeg);

  for (let tap = 0; tap < 30; tap += 1) {
    stepLaunchFrame(state, { ...IDLE, left: true }, world());
    stepLaunchFrame(state, IDLE, world());
  }
  assert.equal(state.aimDeg, LAUNCH_CONTRACT.maxAimDeg, "aim clamps at the shared maximum");
  for (let tap = 0; tap < 30; tap += 1) {
    stepLaunchFrame(state, { ...IDLE, right: true }, world());
    stepLaunchFrame(state, IDLE, world());
  }
  assert.equal(state.aimDeg, LAUNCH_CONTRACT.minAimDeg, "aim clamps at the shared minimum");
  assert.equal(state.x, 100);
  assert.equal(state.y, 200, "the hero stays anchored while aiming");
});

test("firing launches a fixed-power ballistic flight that lands, rests, and returns to the anchor", () => {
  const state = createLaunchState(100, 200);
  const result = stepLaunchFrame(state, { ...IDLE, jump: true }, world());
  assert.equal(result.fired, true);
  assert.equal(state.phase, "flight");
  assert.equal(state.shotsFired, 1);
  const speed = Math.hypot(state.velocityX, state.velocityY);
  assert.ok(Math.abs(speed - LAUNCH_CONTRACT.launchSpeed) < 0.001, "power is fixed");
  assert.ok(state.velocityY < 0, "the default aim launches upward");
  const [expectedX, expectedY] = launchVelocityForAim(LAUNCH_CONTRACT.initialAimDeg);
  assert.ok(Math.abs(state.velocityX - expectedX) < 0.001);
  assert.ok(Math.abs(state.velocityY - expectedY) < 0.001);

  let landedFrame: number | undefined;
  for (let frame = 1; frame <= LAUNCH_CONTRACT.maxFlightFrames; frame += 1) {
    if (stepLaunchFrame(state, IDLE, world()).landed) {
      landedFrame = frame;
      break;
    }
  }
  assert.ok(landedFrame, "the shot must come to rest on the landing surface");
  assert.equal(state.phase, "rest");
  assert.ok(Math.abs((state.y + 43 / 2) - (522 - 18)) <= 4, "rest sits on the platform top");
  let returned = false;
  for (let frame = 0; frame <= LAUNCH_CONTRACT.restFrames; frame += 1) {
    if (stepLaunchFrame(state, IDLE, world()).returnedToAnchor) {
      returned = true;
      break;
    }
  }
  assert.equal(returned, true);
  assert.equal(state.phase, "aiming");
  assert.equal(state.x, 100);
  assert.equal(state.y, 200);
  assert.equal(state.aimDeg, LAUNCH_CONTRACT.initialAimDeg, "the child keeps their aim between shots");

  // The reset clears edge tracking, so a press spanning the reset still fires.
  const refire = stepLaunchFrame(state, { ...IDLE, jump: true }, world());
  assert.equal(refire.fired, true);
  assert.equal(state.shotsFired, 2);
});

test("the launch state machine is deterministic frame for frame", () => {
  const script: LaunchInput[] = [];
  for (let frame = 0; frame < 240; frame += 1) {
    script.push({
      left: frame % 7 === 0 && frame < 20,
      right: frame % 5 === 0 && frame >= 20 && frame < 40,
      jump: frame === 44 || frame === 45,
      action: false,
    });
  }
  const run = (): string[] => {
    const state = createLaunchState(120, 90);
    const trace: string[] = [];
    for (const input of script) {
      stepLaunchFrame(state, input, world());
      trace.push(`${state.phase}:${state.aimDeg}:${state.x.toFixed(3)}:${state.y.toFixed(3)}`);
    }
    return trace;
  };
  assert.deepEqual(run(), run());
});

test("the analytic solver emits identical launch InputFrames for the same spec", () => {
  const first = runPlaytestWithTrace(slingshotFixture(), undefined, 42);
  const second = runPlaytestWithTrace(slingshotFixture(), undefined, 42);
  assert.deepEqual(first, second);
  assert.equal(first.report.reached_goal, true, first.report.first_blocker ?? "no report");
  assert.equal(first.report.visited.includes("flight_hazard"), false, "the certified shot clears the drawn hazard");
  assert.ok(first.inputFrames.some((input) => input.jump), "winning requires a fired shot");
  assert.ok(first.inputFrames.every((input, index) => input.frame === index + 1));
});

test("a multi-shot collect-all slingshot gathers every drawn item across sequential shots", () => {
  const game = slingshotFixture();
  game.entities = [
    { id: "floor", role: "platform", bbox: [0, 0.74, 1, 0.82], behavior: "static", linked_to: null, style_ref: "source" },
    { id: "item_a", role: "collectible", bbox: [0.6, 0.7, 0.64, 0.78], behavior: "static", linked_to: null, style_ref: "source" },
    { id: "item_b", role: "collectible", bbox: [0.81, 0.7, 0.85, 0.78], behavior: "static", linked_to: null, style_ref: "source" },
  ];
  game.goal = { kind: "collect_all", target_id: null };

  const { report, inputFrames } = runPlaytestWithTrace(game, undefined, 42);
  assert.equal(report.reached_goal, true, report.first_blocker ?? "no report");
  assert.ok(report.visited.includes("item_a"));
  assert.ok(report.visited.includes("item_b"));
  let fires = 0;
  let previousJump = false;
  for (const input of inputFrames) {
    if (input.jump && !previousJump) fires += 1;
    previousJump = input.jump;
  }
  assert.ok(fires >= 2, `two drawn items need at least two shots, saw ${fires}`);
  assert.ok(fires <= LAUNCH_CONTRACT.maxSolverShots, "the solver stays inside its shot budget");
});

test("an unreachable slingshot target is refused honestly by the analytic playtest", () => {
  const game = slingshotFixture();
  game.hero.bbox = [0.05, 0.75, 0.12, 0.88];
  game.entities = [
    { id: "floor", role: "platform", bbox: [0, 0.9, 1, 0.96], behavior: "static", linked_to: null, style_ref: "source" },
    { id: "finish", role: "goal", bbox: [0.85, 0.05, 0.92, 0.15], behavior: "static", linked_to: null, style_ref: "source" },
  ];
  const report = runPlaytest(game, undefined, 42);
  assert.equal(report.reached_goal, false);
  assert.match(report.first_blocker ?? "", /^launch_target_unreachable:/);
});

test("slingshot reports faithful_ready only for genuinely supported worlds", () => {
  const faithful = createPlayContract(slingshotFixture());
  assert.equal(faithful.templateId, "lane-a-slingshot-v1");
  assert.equal(faithful.outcome, "faithful_ready");
  assert.ok(faithful.supportedCapabilities.includes("launch_trajectory"));
  assert.deepEqual(faithful.unsupportedCapabilities, []);

  const wet = slingshotFixture();
  wet.entities.push({
    id: "pond", role: "water", bbox: [0.3, 0.6, 0.5, 0.75], behavior: "static", linked_to: null, style_ref: "source",
  });
  const wetContract = createPlayContract(wet);
  assert.equal(wetContract.outcome, "related_fallback", "flight does not honor water volumes");
  assert.ok(wetContract.unsupportedCapabilities.includes("water_swim_volume"));

  const gated = slingshotFixture();
  gated.entities.push(
    { id: "gate_key", role: "key", bbox: [0.3, 0.6, 0.34, 0.68], behavior: "static", linked_to: "gate", style_ref: "source" },
    { id: "gate", role: "door", bbox: [0.6, 0.4, 0.66, 0.74], behavior: "static", linked_to: "gate_key", style_ref: "source" },
  );
  const gatedContract = createPlayContract(gated);
  assert.equal(gatedContract.outcome, "related_fallback", "doors cannot block a flying hero");
  assert.ok(gatedContract.unsupportedCapabilities.includes("key_door_unlock"));
});

function traceEvent(
  sequence: number,
  frame: number,
  kind: RuntimeEvent["kind"],
  status: RuntimeEvent["state"]["status"],
): RuntimeEvent {
  return {
    format: "inkling-runtime-event-v1",
    sequence,
    frame,
    kind,
    entityId: kind === "win" ? "finish" : null,
    required: kind === "win",
    state: {
      status,
      lives: 3,
      collected: 0,
      collectibleTotal: 0,
      assistAvailable: false,
      assistActive: false,
    },
  };
}

test("a slingshot win without a fired shot is rejected by the runtime trace", () => {
  const contract = createPlayContract(slingshotFixture());
  const withoutShot = validateRuntimeTrace([
    traceEvent(0, 0, "state_changed", "playing"),
    traceEvent(1, 5, "input_accepted", "playing"),
    traceEvent(2, 90, "win", "won"),
    traceEvent(3, 90, "state_changed", "won"),
  ], contract);
  assert.equal(withoutShot.valid, false);
  assert.ok(withoutShot.blockers.includes("launch_win_without_fired_shot"));

  const withShot = validateRuntimeTrace([
    traceEvent(0, 0, "state_changed", "playing"),
    traceEvent(1, 5, "input_accepted", "playing"),
    traceEvent(2, 6, "launch_fired", "playing"),
    traceEvent(3, 90, "win", "won"),
    traceEvent(4, 90, "state_changed", "won"),
  ], contract);
  assert.deepEqual(withShot.blockers, []);
  assert.equal(withShot.valid, true);
});
