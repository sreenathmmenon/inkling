import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

import { chromium, type Browser } from "playwright";

import { createPlayContract } from "../packages/runtime/src/play-contract.js";
import type { RuntimeEvent } from "../packages/runtime/src/runtime-events.js";
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

const gameCases: Array<{ id: string; gameSpec: GameSpec }> = [
  { id: "reach", gameSpec: baseGameSpec },
  { id: "collect", gameSpec: collectGameSpec },
  { id: "hazard", gameSpec: hazardGameSpec },
  { id: "vertical", gameSpec: verticalGameSpec },
  { id: "key-door", gameSpec: keyDoorGameSpec },
  { id: "ice", gameSpec: iceGameSpec },
  { id: "water", gameSpec: waterGameSpec },
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
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 960, height: 700 } });
  await page.goto(`http://127.0.0.1:${address.port}/?runtime-replay=1`, { waitUntil: "networkidle" });
  const passingPolicies: ReplayPolicyId[] = ["delayed_noisy", "baseline"];
  const summaries: string[] = [];
  for (const gameCase of gameCases) {
    const analytic = runPlaytestWithTrace(gameCase.gameSpec, 42);
    assert.equal(
      analytic.report.reached_goal,
      true,
      `${gameCase.id}: ${analytic.report.first_blocker ?? "analytic replay failed"}`,
    );
    const playContract = createPlayContract(gameCase.gameSpec);
    assert.equal(playContract.outcome, "faithful_ready", `${gameCase.id}: contract is not faithful`);
    for (const policy of passingPolicies) {
      const inputFrames = applyReplayPolicy(analytic.inputFrames, policy);
      const events = await page.evaluate(async (input) => {
        const api = window.__INKLING_REPLAY__;
        if (!api) throw new Error("Inkling runtime replay API is unavailable");
        return api.run(input.gameSpec, input.inputFrames);
      }, { gameSpec: gameCase.gameSpec, inputFrames }) as RuntimeEvent[];
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
  }
  console.log(`Production Phaser policies passed: ${summaries.join(", ")}; all idle policies stayed playing.`);
} finally {
  await browser?.close();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}
