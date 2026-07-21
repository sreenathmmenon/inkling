import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

import { chromium, type Browser } from "playwright";

import { createPlayContract } from "../packages/runtime/src/play-contract.js";
import type { RuntimeEvent } from "../packages/runtime/src/runtime-events.js";
import { createDeterministicSafetyRecast } from "../runner/pipeline.js";
import type { GameSpec } from "../runner/types.js";
import { runPlaytestWithTrace } from "../services/solve/src/playtest.js";
import { validateRuntimeTrace } from "../services/solve/src/runtime-trace.js";
import {
  applyReplayPolicy,
  type ReplayPolicyId,
} from "../services/solve/src/replay-policies.js";
import { findProjectRoot } from "../runner/spec.js";

const baseGameSpec: GameSpec = {
  primary_genre: "platformer", genre_confidence: 1, mood: null,
  hero: { id: "hero", name: "Hero", bbox: [0.08, 0.58, 0.15, 0.72], style_ref: "source" },
  entities: [
    { id: "floor", role: "platform", bbox: [0, 0.74, 1, 0.82], behavior: "static", linked_to: null, style_ref: "source" },
    { id: "finish", role: "goal", bbox: [0.82, 0.55, 0.9, 0.74], behavior: "static", linked_to: null, style_ref: "source" },
  ],
  goal: { kind: "reach_goal", target_id: "finish" },
  rules: { lives: 3, difficulty_hint: "normal", modifiers: [] },
  palette: ["#fffaf0", "#211c38", "#ffd556", "#7bc47f"], assumptions: [], flags: [],
};

const collectGameSpec = structuredClone(baseGameSpec);
collectGameSpec.entities.splice(1, 0,
  { id: "item_a", role: "collectible", bbox: [0.35, 0.62, 0.4, 0.7], behavior: "static", linked_to: null, style_ref: "source" },
  { id: "item_b", role: "collectible", bbox: [0.62, 0.62, 0.67, 0.7], behavior: "static", linked_to: null, style_ref: "source" },
);
collectGameSpec.goal = { kind: "collect_all", target_id: null };

const reachInteractionGameSpec = structuredClone(baseGameSpec);
reachInteractionGameSpec.entities.splice(1, 0,
  // reach_goal means reach the goal: these drawn collectibles are bonus and
  // must never gate the win. Key->door gating is proven by the key-door case.
  { id: "interaction_ledge", role: "platform", bbox: [0.2, 0.5, 0.38, 0.56], behavior: "static", linked_to: null, style_ref: "source" },
  { id: "interaction_detour", role: "collectible", bbox: [0.27, 0.42, 0.32, 0.5], behavior: "static", linked_to: null, style_ref: "source" },
  { id: "interaction_route", role: "collectible", bbox: [0.5, 0.62, 0.55, 0.7], behavior: "static", linked_to: null, style_ref: "source" },
);

const hazardGameSpec = structuredClone(baseGameSpec);
hazardGameSpec.entities.splice(1, 0, {
  id: "hazard", role: "hazard", bbox: [0.45, 0.66, 0.52, 0.74], behavior: "static", linked_to: null, style_ref: "source",
});

const verticalGameSpec = structuredClone(baseGameSpec);
verticalGameSpec.entities = [
  { id: "floor", role: "platform", bbox: [0, 0.8, 1, 0.87], behavior: "static", linked_to: null, style_ref: "source" },
  { id: "ledge_a", role: "platform", bbox: [0.24, 0.61, 0.45, 0.67], behavior: "static", linked_to: null, style_ref: "source" },
  { id: "ledge_b", role: "platform", bbox: [0.5, 0.42, 0.72, 0.48], behavior: "static", linked_to: null, style_ref: "source" },
  { id: "item_a", role: "collectible", bbox: [0.33, 0.52, 0.38, 0.6], behavior: "static", linked_to: null, style_ref: "source" },
  { id: "item_b", role: "collectible", bbox: [0.6, 0.33, 0.65, 0.41], behavior: "static", linked_to: null, style_ref: "source" },
];
verticalGameSpec.goal = { kind: "collect_all", target_id: null };

const keyDoorGameSpec = structuredClone(baseGameSpec);
keyDoorGameSpec.entities = [
  { id: "floor", role: "platform", bbox: [0, 0.74, 1, 0.82], behavior: "static", linked_to: null, style_ref: "source" },
  { id: "key", role: "key", bbox: [0.28, 0.62, 0.34, 0.72], behavior: "static", linked_to: "door", style_ref: "source" },
  { id: "door", role: "door", bbox: [0.52, 0.44, 0.59, 0.74], behavior: "static", linked_to: "key", style_ref: "source" },
  { id: "finish", role: "goal", bbox: [0.82, 0.55, 0.9, 0.74], behavior: "static", linked_to: null, style_ref: "source" },
];

const iceGameSpec = structuredClone(baseGameSpec);
iceGameSpec.entities[0] = {
  id: "ice_floor", role: "ice", bbox: [0, 0.74, 1, 0.82], behavior: "static", linked_to: null, style_ref: "source",
};

const waterGameSpec = structuredClone(baseGameSpec);
waterGameSpec.entities.splice(1, 0, {
  id: "water", role: "water", bbox: [0.16, 0.5, 0.78, 0.8], behavior: "static", linked_to: null, style_ref: "source",
});

const mazeGameSpec = structuredClone(baseGameSpec);
mazeGameSpec.primary_genre = "maze";
mazeGameSpec.hero.bbox = [0.08, 0.12, 0.15, 0.25];
mazeGameSpec.entities = [
  { id: "wall", role: "platform", bbox: [0.47, 0, 0.53, 0.68], behavior: "static", linked_to: null, style_ref: "source" },
  { id: "finish", role: "goal", bbox: [0.82, 0.12, 0.9, 0.25], behavior: "static", linked_to: null, style_ref: "source" },
];
mazeGameSpec.goal = { kind: "reach_goal", target_id: "finish" };

const runnerGameSpec = structuredClone(baseGameSpec);
runnerGameSpec.primary_genre = "runner";
runnerGameSpec.entities.splice(1, 0, {
  id: "runner_hazard", role: "hazard", bbox: [0.44, 0.66, 0.5, 0.74], behavior: "static", linked_to: null, style_ref: "source",
});

// Faithful aim-and-launch: the anchored hero must clear a drawn hazard on a
// quantized ballistic shot and reach the drawn goal. The analytic route and
// the browser replay both consume the shared launch state machine.
const slingshotGameSpec = structuredClone(baseGameSpec);
slingshotGameSpec.primary_genre = "slingshot";
slingshotGameSpec.hero.bbox = [0.08, 0.08, 0.15, 0.22];
slingshotGameSpec.entities.splice(1, 0, {
  id: "flight_hazard", role: "hazard", bbox: [0.45, 0.66, 0.52, 0.74], behavior: "static", linked_to: null, style_ref: "source",
});

// A large free-movement hero and clustered edge-adjacent targets exercise the
// same precision/recovery class as arbitrary child drawings with coarse touch
// input. Runtime behavior remains entirely geometry-driven.
const freePrecisionGameSpec = structuredClone(baseGameSpec);
freePrecisionGameSpec.primary_genre = "roller";
freePrecisionGameSpec.hero.bbox = [0.02, 0.31, 0.39, 0.59];
freePrecisionGameSpec.entities = [
  [0.06, 0.06, 0.19, 0.14],
  [0.25, 0.05, 0.41, 0.16],
  [0.1, 0.18, 0.2, 0.25],
  [0.3, 0.2, 0.41, 0.28],
  [0.06, 0.26, 0.13, 0.31],
  [0.37, 0.31, 0.44, 0.35],
].map((bbox, index) => ({
  id: `precision_item_${index + 1}`,
  role: "collectible",
  bbox: bbox as [number, number, number, number],
  behavior: "static",
  linked_to: null,
  style_ref: "source",
}));
freePrecisionGameSpec.goal = { kind: "collect_all", target_id: null };

// These fixtures isolate assist behavior itself. The required target starts
// outside the production collider but inside the declared assist reach, so a
// pickup immediately after activation cannot be credited to ordinary overlap.
const freeAssistPickupGameSpec = structuredClone(baseGameSpec);
freeAssistPickupGameSpec.primary_genre = "roller";
freeAssistPickupGameSpec.hero.bbox = [0.02, 0.03, 0.12, 0.16];
freeAssistPickupGameSpec.entities = [{
  id: "free_assist_target", role: "collectible", bbox: [0.15, 0.07, 0.19, 0.13],
  behavior: "static", linked_to: null, style_ref: "source",
}];
freeAssistPickupGameSpec.goal = { kind: "collect_all", target_id: null };

const groundedKeyAssistGameSpec = structuredClone(baseGameSpec);
groundedKeyAssistGameSpec.hero.bbox = [0.02, 0.58, 0.12, 0.72];
groundedKeyAssistGameSpec.entities = [
  { id: "floor", role: "platform", bbox: [0, 0.74, 1, 0.82], behavior: "static", linked_to: null, style_ref: "source" },
  { id: "assist_key", role: "key", bbox: [0.12, 0.62, 0.155, 0.7], behavior: "static", linked_to: "assist_door", style_ref: "source" },
  { id: "assist_door", role: "door", bbox: [0.52, 0.44, 0.59, 0.74], behavior: "static", linked_to: "assist_key", style_ref: "source" },
  { id: "finish", role: "goal", bbox: [0.82, 0.55, 0.9, 0.74], behavior: "static", linked_to: null, style_ref: "source" },
];

const walledAssistGameSpec = structuredClone(baseGameSpec);
walledAssistGameSpec.primary_genre = "maze";
walledAssistGameSpec.hero.bbox = [0.4, 0.3, 0.48, 0.42];
walledAssistGameSpec.entities = [
  { id: "wall", role: "platform", bbox: [0.485, 0, 0.495, 0.7], behavior: "static", linked_to: null, style_ref: "source" },
  { id: "walled_target", role: "collectible", bbox: [0.5, 0.33, 0.54, 0.39], behavior: "static", linked_to: null, style_ref: "source" },
  { id: "finish", role: "goal", bbox: [0.82, 0.32, 0.9, 0.45], behavior: "static", linked_to: null, style_ref: "source" },
];
walledAssistGameSpec.goal = { kind: "collect_all", target_id: null };

const lockedDoorAssistGameSpec = structuredClone(baseGameSpec);
lockedDoorAssistGameSpec.primary_genre = "maze";
lockedDoorAssistGameSpec.hero.bbox = [0.4, 0.3, 0.48, 0.42];
lockedDoorAssistGameSpec.entities = [
  { id: "maze_wall", role: "platform", bbox: [0.7, 0, 0.72, 0.7], behavior: "static", linked_to: null, style_ref: "source" },
  { id: "locked_door", role: "door", bbox: [0.485, 0.2, 0.495, 0.5], behavior: "static", linked_to: "door_key", style_ref: "source" },
  { id: "door_key", role: "key", bbox: [0.1, 0.33, 0.14, 0.39], behavior: "static", linked_to: "locked_door", style_ref: "source" },
  { id: "door_side_target", role: "collectible", bbox: [0.5, 0.33, 0.54, 0.39], behavior: "static", linked_to: null, style_ref: "source" },
  { id: "finish", role: "goal", bbox: [0.82, 0.32, 0.9, 0.45], behavior: "static", linked_to: null, style_ref: "source" },
];
lockedDoorAssistGameSpec.goal = { kind: "collect_all", target_id: null };

function assistFrames(control: "left" | "right" | "jump"): Array<{
  format: "inkling-input-frame-v1";
  frame: number;
  left: boolean;
  right: boolean;
  jump: boolean;
  down: boolean;
  action: boolean;
  assist: boolean;
}> {
  return Array.from({ length: 721 }, (_, index) => ({
    format: "inkling-input-frame-v1" as const,
    frame: index + 1,
    left: control === "left",
    right: control === "right",
    jump: control === "jump",
    down: false,
    action: false,
    assist: index === 719,
  }));
}

const gameCases: Array<{ id: string; gameSpec: GameSpec }> = [
  { id: "reach", gameSpec: baseGameSpec },
  { id: "reach-interactions", gameSpec: reachInteractionGameSpec },
  { id: "collect", gameSpec: collectGameSpec },
  { id: "hazard", gameSpec: hazardGameSpec },
  { id: "vertical", gameSpec: verticalGameSpec },
  { id: "key-door", gameSpec: keyDoorGameSpec },
  { id: "ice", gameSpec: iceGameSpec },
  { id: "water", gameSpec: waterGameSpec },
  { id: "maze", gameSpec: mazeGameSpec },
  { id: "runner", gameSpec: runnerGameSpec },
  { id: "slingshot", gameSpec: slingshotGameSpec },
];

const publicRoot = resolve(findProjectRoot(), "build/client");

function contentType(path: string): string {
  if (extname(path) === ".js") return "text/javascript; charset=utf-8";
  if (extname(path) === ".html") return "text/html; charset=utf-8";
  return "application/octet-stream";
}

async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true });
  } catch (firstError) {
    try {
      return await chromium.launch({ channel: "chrome", headless: true });
    } catch {
      throw firstError;
    }
  }
}

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = resolve(publicRoot, relative);
  if (target !== publicRoot && !target.startsWith(`${publicRoot}${sep}`)) {
    response.writeHead(400).end();
    return;
  }
  try {
    const bytes = await readFile(target);
    response.writeHead(200, {
      "content-type": contentType(target),
      "cache-control": "no-store",
    });
    response.end(bytes);
  } catch {
    response.writeHead(404).end();
  }
});

await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
assert.ok(address && typeof address === "object");
let browser: Browser | undefined;
try {
  const activeBrowser = await launchBrowser();
  browser = activeBrowser;
  const createReplayPage = async () => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const replayPage = await activeBrowser.newPage({ viewport: { width: 960, height: 700 } });
      try {
        await replayPage.goto(`http://127.0.0.1:${address.port}/?runtime-replay=1`, { waitUntil: "domcontentloaded" });
        await replayPage.waitForFunction(() => Boolean(window.__INKLING_REPLAY__), undefined, { timeout: 45_000 });
        return replayPage;
      } catch (error) {
        lastError = error;
        await replayPage.close();
      }
    }
    throw new Error(`Production replay page failed to start twice: ${String(lastError)}`);
  };
  let page = await createReplayPage();
  const passingPolicies: ReplayPolicyId[] = ["delayed_noisy", "baseline"];
  const summaries: string[] = [];
  for (const [caseIndex, gameCase] of gameCases.entries()) {
    // A real player launches one Phaser game at a time. Reset the harness page
    // between synthetic case batches so retired WebGL/Arcade resources cannot
    // make later cases fail to start for reasons no customer can encounter.
    if (caseIndex > 0) {
      await page.close();
      page = await createReplayPage();
    }
    const analytic = runPlaytestWithTrace(gameCase.gameSpec, undefined, 42);
    assert.equal(
      analytic.report.reached_goal,
      true,
      `${gameCase.id}: ${analytic.report.first_blocker ?? "analytic replay failed"}`,
    );
    const playContract = createPlayContract(gameCase.gameSpec);
    assert.equal(playContract.outcome, "faithful_ready", `${gameCase.id}: contract is not faithful`);
    for (const policy of passingPolicies) {
      const inputFrames = applyReplayPolicy(analytic.inputFrames, policy);
      let events: RuntimeEvent[];
      try {
        events = await page.evaluate(async (input) => {
          const api = window.__INKLING_REPLAY__;
          if (!api) throw new Error("Inkling runtime replay API is unavailable");
          return api.run(input.gameSpec, input.inputFrames);
        }, { gameSpec: gameCase.gameSpec, inputFrames }) as RuntimeEvent[];
      } catch (error) {
        throw new Error(`${gameCase.id}/${policy}: ${String(error)}`);
      }
      const report = validateRuntimeTrace(events, playContract);
      if (!report.valid) {
        console.error("Production Phaser replay evidence:", JSON.stringify({ gameCase: gameCase.id, policy, report, events }, null, 2));
      }
      assert.equal(report.valid, true, `${gameCase.id}/${policy}: ${report.blockers.join(", ")}`);
      assert.equal(report.finalStatus, "won");
      summaries.push(`${gameCase.id}/${policy}@${report.finalFrame}`);
    }

    const idleEvents = await page.evaluate(async (input) => {
      const api = window.__INKLING_REPLAY__;
      if (!api) throw new Error("Inkling runtime replay API is unavailable");
      return api.run(input.gameSpec, input.inputFrames);
    }, {
      gameSpec: gameCase.gameSpec,
      inputFrames: applyReplayPolicy(analytic.inputFrames, "idle"),
    }) as RuntimeEvent[];
    const idleReport = validateRuntimeTrace(idleEvents, playContract);
    assert.equal(idleReport.finalStatus, "playing", `${gameCase.id}: active play won with no input`);
    assert.equal(idleReport.inputAccepted, false);
    assert.ok(idleReport.blockers.includes("runtime_trace_has_no_terminal_state"));
    if (gameCase.id === "slingshot") {
      assert.equal(
        idleEvents.some((event) => event.kind === "launch_fired"),
        false,
        "slingshot fired a shot with no input",
      );
    }

    const recoveryAttempt = applyReplayPolicy(analytic.inputFrames, "recovery");
    const recoveryEvents = await page.evaluate(async (input) => {
      const api = window.__INKLING_REPLAY__;
      if (!api) throw new Error("Inkling runtime replay API is unavailable");
      return api.run(input.gameSpec, input.inputFrames);
    }, { gameSpec: gameCase.gameSpec, inputFrames: recoveryAttempt }) as RuntimeEvent[];
    assert.ok(
      recoveryEvents.some((event) => event.kind === "input_accepted"),
      `${gameCase.id}: recovery attempt did not reach the real input path`,
    );
    const restartedEvents = await page.evaluate(async (input) => {
      const api = window.__INKLING_REPLAY__;
      if (!api) throw new Error("Inkling runtime replay API is unavailable");
      return api.run(input.gameSpec, input.inputFrames);
    }, {
      gameSpec: gameCase.gameSpec,
      inputFrames: applyReplayPolicy(analytic.inputFrames, "baseline"),
    }) as RuntimeEvent[];
    const restartedReport = validateRuntimeTrace(restartedEvents, playContract);
    assert.equal(
      restartedReport.valid,
      true,
      `${gameCase.id}/restart: ${restartedReport.blockers.join(", ")}`,
    );
    summaries.push(`${gameCase.id}/restart@${restartedReport.finalFrame}`);

    if (gameCase.id === "reach") {
      const assistedEvents = await page.evaluate(async (input) => {
        const api = window.__INKLING_REPLAY__;
        if (!api) throw new Error("Inkling runtime replay API is unavailable");
        return api.run(input.gameSpec, input.inputFrames);
      }, {
        gameSpec: gameCase.gameSpec,
        inputFrames: applyReplayPolicy(analytic.inputFrames, "assist_recovery"),
      }) as RuntimeEvent[];
      assert.ok(assistedEvents.some((event) => event.kind === "stuck_cue"));
      assert.ok(assistedEvents.some((event) => event.kind === "assist_available"));
      assert.ok(assistedEvents.some((event) => event.kind === "assist_activated"));
      const assistedReport = validateRuntimeTrace(assistedEvents, playContract);
      assert.equal(assistedReport.valid, true, `reach/assist: ${assistedReport.blockers.join(", ")}`);
      summaries.push(`reach/assist@${assistedReport.finalFrame}`);
    }
    if (gameCase.id === "reach-interactions") {
      const directFrames = Array.from({ length: 420 }, (_, index) => ({
        format: "inkling-input-frame-v1" as const,
        frame: index + 1,
        left: false,
        right: true,
        jump: false,
        down: false,
        action: false,
        assist: false,
      }));
      const bypassEvents = await page.evaluate(async (input) => {
        const api = window.__INKLING_REPLAY__;
        if (!api) throw new Error("Inkling runtime replay API is unavailable");
        return api.run(input.gameSpec, input.inputFrames);
      }, { gameSpec: gameCase.gameSpec, inputFrames: directFrames }) as RuntimeEvent[];
      const finalBypass = bypassEvents.at(-1);
      assert.equal(
        finalBypass?.state.status,
        "won",
        "reach_goal must be winnable by reaching the goal — bonus items never gate",
      );
      assert.equal(
        bypassEvents.some((event) => event.kind === "pickup" && event.entityId === "interaction_detour"),
        false,
        "the ledge bonus was skipped entirely — and the win stood anyway",
      );
      const bonusReport = validateRuntimeTrace(bypassEvents, createPlayContract(gameCase.gameSpec));
      assert.equal(bonusReport.valid, true, `bonus-skip win must trace legally: ${bonusReport.blockers.join(",")}`);
      summaries.push("reach-interactions/bonus-skip-won");
    }
    if (gameCase.id === "maze") {
      const directFrames = Array.from({ length: 300 }, (_, index) => ({
        format: "inkling-input-frame-v1" as const,
        frame: index + 1,
        left: false,
        right: true,
        jump: false,
        down: false,
        action: false,
        assist: false,
      }));
      const collisionEvents = await page.evaluate(async (input) => {
        const api = window.__INKLING_REPLAY__;
        if (!api) throw new Error("Inkling runtime replay API is unavailable");
        return api.run(input.gameSpec, input.inputFrames);
      }, { gameSpec: gameCase.gameSpec, inputFrames: directFrames }) as RuntimeEvent[];
      assert.ok(collisionEvents.some((event) => event.kind === "maze_wall_contact"));
      assert.equal(collisionEvents.at(-1)?.state.status, "playing", "maze wall allowed a straight-through win");
      summaries.push("maze/wall-blocked");
    }
  }

  const safetyRecast = createDeterministicSafetyRecast(hazardGameSpec);
  const safetyAnalytic = runPlaytestWithTrace(safetyRecast, undefined, 42);
  assert.equal(safetyAnalytic.report.reached_goal, true, "P8 safety recast analytic route failed");
  assert.equal(createPlayContract(safetyRecast).outcome, "related_fallback");
  const safetyEvents = await page.evaluate(async (input) => {
    const api = window.__INKLING_REPLAY__;
    if (!api) throw new Error("Inkling runtime replay API is unavailable");
    return api.run(input.gameSpec, input.inputFrames);
  }, { gameSpec: safetyRecast, inputFrames: safetyAnalytic.inputFrames }) as RuntimeEvent[];
  assert.equal(safetyEvents.at(-1)?.state.status, "won", "production Phaser did not finish the P8 safety recast");
  assert.ok(safetyEvents.some((event) => event.kind === "input_accepted"), "P8 safety recast finished without player input");
  summaries.push(`p8-safety-recast@${safetyEvents.at(-1)?.frame ?? 0}`);

  await page.close();
  page = await createReplayPage();
  const precisionAnalytic = runPlaytestWithTrace(freePrecisionGameSpec, undefined, 42);
  assert.equal(precisionAnalytic.report.reached_goal, true, "free precision analytic route failed");
  const precisionEvents = await page.evaluate(async (input) => {
    const api = window.__INKLING_REPLAY__;
    if (!api) throw new Error("Inkling runtime replay API is unavailable");
    return api.run(input.gameSpec, input.inputFrames);
  }, {
    gameSpec: freePrecisionGameSpec,
    inputFrames: applyReplayPolicy(precisionAnalytic.inputFrames, "assist_recovery"),
  }) as RuntimeEvent[];
  assert.ok(precisionEvents.some((event) => event.kind === "stuck_cue"));
  assert.ok(precisionEvents.some((event) => event.kind === "assist_available"));
  assert.ok(precisionEvents.some((event) => event.kind === "assist_activated"));
  assert.equal(precisionEvents.at(-1)?.state.status, "won", "free-movement assist left the player stuck");
  assert.equal(precisionEvents.at(-1)?.state.collected, 6, "free-movement assist skipped a required pickup");
  summaries.push(`free-precision/assist@${precisionEvents.at(-1)?.frame ?? 0}`);

  const freeAssistEvents = await page.evaluate(async (input) => {
    const api = window.__INKLING_REPLAY__;
    if (!api) throw new Error("Inkling runtime replay API is unavailable");
    return api.run(input.gameSpec, input.inputFrames);
  }, { gameSpec: freeAssistPickupGameSpec, inputFrames: assistFrames("jump") }) as RuntimeEvent[];
  const freeAssistedPickup = freeAssistEvents.find((event) => (
    event.kind === "pickup" && event.entityId === "free_assist_target"
  ));
  assert.ok(freeAssistEvents.some((event) => event.kind === "assist_activated"));
  assert.ok(freeAssistedPickup && freeAssistedPickup.frame <= 721, "free-movement assist did not forgive a proven near miss");
  assert.equal(freeAssistEvents.at(-1)?.state.status, "won");
  summaries.push(`assist/free-pickup@${freeAssistedPickup.frame}`);

  const groundedAssistEvents = await page.evaluate(async (input) => {
    const api = window.__INKLING_REPLAY__;
    if (!api) throw new Error("Inkling runtime replay API is unavailable");
    return api.run(input.gameSpec, input.inputFrames);
  }, { gameSpec: groundedKeyAssistGameSpec, inputFrames: assistFrames("left") }) as RuntimeEvent[];
  const groundedAssistedPickup = groundedAssistEvents.find((event) => (
    event.kind === "pickup" && event.entityId === "assist_key"
  ));
  assert.ok(groundedAssistEvents.some((event) => event.kind === "assist_activated"));
  assert.ok(groundedAssistedPickup && groundedAssistedPickup.frame <= 721, "grounded required-key assist did not forgive a proven near miss");
  assert.equal(groundedAssistedPickup.state.collected, 1);
  summaries.push(`assist/ground-key@${groundedAssistedPickup.frame}`);

  const walledAssistEvents = await page.evaluate(async (input) => {
    const api = window.__INKLING_REPLAY__;
    if (!api) throw new Error("Inkling runtime replay API is unavailable");
    return api.run(input.gameSpec, input.inputFrames);
  }, { gameSpec: walledAssistGameSpec, inputFrames: assistFrames("right") }) as RuntimeEvent[];
  assert.ok(walledAssistEvents.some((event) => event.kind === "maze_wall_contact"), "walled assist fixture never contacted its wall");
  assert.ok(walledAssistEvents.some((event) => event.kind === "assist_activated"), "walled assist fixture never activated help");
  assert.equal(walledAssistEvents.some((event) => event.kind === "pickup" && event.entityId === "walled_target"), false, "assist collected through a maze wall");
  assert.equal(walledAssistEvents.at(-1)?.state.status, "playing", "walled assist bypassed the maze");
  summaries.push("assist/wall-blocked");

  const lockedDoorAssistEvents = await page.evaluate(async (input) => {
    const api = window.__INKLING_REPLAY__;
    if (!api) throw new Error("Inkling runtime replay API is unavailable");
    return api.run(input.gameSpec, input.inputFrames);
  }, { gameSpec: lockedDoorAssistGameSpec, inputFrames: assistFrames("right") }) as RuntimeEvent[];
  assert.ok(lockedDoorAssistEvents.some((event) => event.kind === "assist_activated"), "locked-door assist fixture never activated help");
  assert.equal(lockedDoorAssistEvents.some((event) => event.kind === "pickup" && event.entityId === "door_side_target"), false, "assist collected through a locked door");
  assert.equal(lockedDoorAssistEvents.at(-1)?.state.status, "playing", "locked-door assist bypassed the maze");
  summaries.push("assist/locked-door-blocked");

  const soakFrames = runPlaytestWithTrace(baseGameSpec, undefined, 42).inputFrames;
  for (let launch = 1; launch <= 12; launch += 1) {
    const soakEvents = await page.evaluate(async (input) => {
      const api = window.__INKLING_REPLAY__;
      if (!api) throw new Error("Inkling runtime replay API is unavailable");
      return api.run(input.gameSpec, input.inputFrames);
    }, { gameSpec: baseGameSpec, inputFrames: soakFrames }) as RuntimeEvent[];
    assert.equal(soakEvents.at(-1)?.state.status, "won", `same-page Phaser launch ${launch} did not finish`);
  }
  summaries.push("same-page-soak×12");
  console.log(`Production Phaser policies passed: ${summaries.join(", ")}; all idle policies stayed playing.`);
} finally {
  await browser?.close();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}
