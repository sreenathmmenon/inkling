import assert from "node:assert/strict";
import { test } from "node:test";

import {
  certifiedDriveUrl,
  classifyDriveTick,
  type DriveTick,
} from "../scripts/journey-driver.js";

const drive = { reachedGoal: true, timeToWin: 21.5, frameCount: 1290 };

function tick(overrides: Partial<DriveTick>): DriveTick {
  return { bodyClasses: ["playing"], drive, gameStatus: "Lives 3", ...overrides };
}

test("certifiedDriveUrl adds the flag exactly once and keeps existing params", () => {
  const enabled = certifiedDriveUrl("http://127.0.0.1:5173/?foo=1");
  assert.ok(new URL(enabled).searchParams.has("certified-drive"));
  assert.equal(new URL(enabled).searchParams.get("foo"), "1");
  assert.equal(certifiedDriveUrl(enabled), enabled);
});

test("a won body class ends the drive as won", () => {
  const verdict = classifyDriveTick(tick({ bodyClasses: ["won", "game-won"] }), {
    restarts: 0, maxRestarts: 2, playingSinceMs: null, graceMs: 8_000,
  });
  assert.deepEqual(verdict, { done: true, result: "won" });
});

test("a trace that cannot reach the goal reports drive-unavailable", () => {
  const verdict = classifyDriveTick(
    tick({ drive: { reachedGoal: false, timeToWin: null, frameCount: 0 } }),
    { restarts: 0, maxRestarts: 2, playingSinceMs: 0, graceMs: 8_000 },
  );
  assert.deepEqual(verdict, { done: true, result: "drive-unavailable" });
});

test("losses restart within the bounded budget, then report lost", () => {
  const lost = tick({ bodyClasses: ["lost", "game-lost"] });
  const context = { maxRestarts: 2, playingSinceMs: null, graceMs: 8_000 };
  assert.deepEqual(classifyDriveTick(lost, { ...context, restarts: 0 }), { done: false, restart: true });
  assert.deepEqual(classifyDriveTick(lost, { ...context, restarts: 2 }), { done: true, result: "lost" });
});

test("playing without a drive lane falls back after the grace window", () => {
  const undriven = tick({ drive: null });
  const context = { restarts: 0, maxRestarts: 2, graceMs: 8_000 };
  assert.deepEqual(
    classifyDriveTick(undriven, { ...context, playingSinceMs: 2_000 }),
    { done: false, restart: false },
  );
  assert.deepEqual(
    classifyDriveTick(undriven, { ...context, playingSinceMs: 9_000 }),
    { done: true, result: "drive-unavailable" },
  );
});
