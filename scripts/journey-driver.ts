import type { Page } from "playwright";

/**
 * Certified-route journey driver.
 *
 * Live journey harnesses could not reliably win generated worlds with blind
 * input sweeps, which made win-gated affordances (save, rescan) undrivable.
 * This driver instead rides the client's `certified-drive` lane
 * (apps/client/src/main.ts): with the flag in the page URL, every interactive
 * launch replays the deterministic playtester's own winning InputFrames
 * through the production Phaser scene, frame-exact — the same trace and the
 * same scene the readiness certification already proved agree. That makes the
 * drive general (any certified world), deterministic (no wall-clock drift to
 * re-sync; frames are consumed by fixed-step frame number), and honest (the
 * win is earned by real scene physics on legal inputs, not by state edits).
 *
 * Tolerance still lives here: bounded restart retries (a restart replays the
 * trace from frame zero) and a grace verdict when the drive lane is absent or
 * the trace could not reach the goal, so callers can fall back to manual play.
 * This is test/evidence plumbing only — it never weakens a gate, and the
 * runtime assist stays available to the trace itself (InputFrame.assist).
 */

export const CERTIFIED_DRIVE_FLAG = "certified-drive";

/** Returns the URL with the certified-drive lane enabled. */
export function certifiedDriveUrl(url: string): string {
  const parsed = new URL(url);
  if (!parsed.searchParams.has(CERTIFIED_DRIVE_FLAG)) {
    parsed.searchParams.set(CERTIFIED_DRIVE_FLAG, "1");
  }
  return parsed.href;
}

export interface CertifiedDriveInfo {
  reachedGoal: boolean;
  timeToWin: number | null;
  frameCount: number;
}

export interface JourneyRuntimeEvent {
  kind: string;
  frame: number;
  status: string;
}

export interface DriveTick {
  bodyClasses: readonly string[];
  drive: CertifiedDriveInfo | null;
  gameStatus: string | null;
}

export type DriveVerdict =
  | { done: true; result: "won" | "lost" | "drive-unavailable" }
  | { done: false; restart: boolean };

/**
 * Pure per-poll decision: win/lose detection, bounded restarts, and the
 * drive-unavailable fallbacks (trace failed to reach the goal, or the page
 * has been playing for a while with no drive lane at all).
 */
export function classifyDriveTick(
  tick: DriveTick,
  context: { restarts: number; maxRestarts: number; playingSinceMs: number | null; graceMs: number },
): DriveVerdict {
  if (tick.bodyClasses.includes("won")) return { done: true, result: "won" };
  if (tick.drive && !tick.drive.reachedGoal) {
    return { done: true, result: "drive-unavailable" };
  }
  if (tick.bodyClasses.includes("lost")) {
    if (context.restarts >= context.maxRestarts) return { done: true, result: "lost" };
    return { done: false, restart: true };
  }
  if (
    tick.drive === null &&
    tick.bodyClasses.includes("playing") &&
    context.playingSinceMs !== null &&
    context.playingSinceMs >= context.graceMs
  ) {
    return { done: true, result: "drive-unavailable" };
  }
  return { done: false, restart: false };
}

export interface DriveOptions {
  /** Overall budget for reaching the win state. */
  maxMs?: number;
  /** Bounded retries: each restart replays the certified trace from frame 0. */
  maxRestarts?: number;
  pollMs?: number;
}

export interface DriveResult {
  result: "won" | "lost" | "timeout" | "drive-unavailable";
  restarts: number;
  ms: number;
  drive: CertifiedDriveInfo | null;
  gameStatus: string | null;
  runtimeEvents: JourneyRuntimeEvent[];
}

/**
 * Records the scene's own semantic runtime events (re-dispatched by the client
 * as `inkling:runtime-event`) so a journey can prove a win came from real
 * gameplay — pickups, landings, state changes — rather than asserting a CSS
 * class alone. Call once per page, before or after load.
 */
export async function installJourneyEventCollector(page: Page): Promise<void> {
  const collector = (): void => {
    const holder = window as unknown as {
      __INKLING_JOURNEY_EVENTS__?: JourneyRuntimeEvent[];
    };
    if (holder.__INKLING_JOURNEY_EVENTS__) return;
    const bucket: JourneyRuntimeEvent[] = [];
    holder.__INKLING_JOURNEY_EVENTS__ = bucket;
    window.addEventListener("inkling:runtime-event", (event) => {
      const detail = (event as CustomEvent<{
        kind: string;
        frame: number;
        state: { status: string };
      }>).detail;
      if (!detail || bucket.length >= 5_000) return;
      bucket.push({ kind: detail.kind, frame: detail.frame, status: detail.state.status });
    });
  };
  await page.addInitScript(collector);
  await page.evaluate(collector).catch(() => undefined);
}

function readTick(page: Page): Promise<DriveTick> {
  return page.evaluate(() => ({
    bodyClasses: [...document.body.classList],
    drive: (window as unknown as {
      __INKLING_CERTIFIED_DRIVE__?: CertifiedDriveInfo;
    }).__INKLING_CERTIFIED_DRIVE__ ?? null,
    gameStatus: document.getElementById("game-status")?.textContent?.trim() ?? null,
  }));
}

function readJourneyEvents(page: Page): Promise<JourneyRuntimeEvent[]> {
  return page.evaluate(() => (window as unknown as {
    __INKLING_JOURNEY_EVENTS__?: JourneyRuntimeEvent[];
  }).__INKLING_JOURNEY_EVENTS__ ?? []);
}

/**
 * Drives the current interactive game to its certified win. Expects the page
 * to be on the app with the certified-drive flag (see certifiedDriveUrl) and a
 * game launching or playing; resolves when the world is won, the retry budget
 * is spent, the drive lane is unavailable, or the time budget runs out.
 */
export async function driveCertifiedWin(
  page: Page,
  options: DriveOptions = {},
): Promise<DriveResult> {
  const maxMs = options.maxMs ?? 300_000;
  const maxRestarts = options.maxRestarts ?? 2;
  const pollMs = options.pollMs ?? 400;
  const graceMs = 8_000;
  const startedAt = Date.now();
  let restarts = 0;
  let playingSince: number | null = null;
  let lastTick: DriveTick | null = null;

  while (Date.now() - startedAt < maxMs) {
    const tick = await readTick(page);
    lastTick = tick;
    if (tick.bodyClasses.includes("playing")) playingSince ??= Date.now();
    else if (!tick.bodyClasses.includes("lost")) playingSince = null;
    const verdict = classifyDriveTick(tick, {
      restarts,
      maxRestarts,
      playingSinceMs: playingSince === null ? null : Date.now() - playingSince,
      graceMs,
    });
    if (verdict.done) {
      return {
        result: verdict.result,
        restarts,
        ms: Date.now() - startedAt,
        drive: tick.drive,
        gameStatus: tick.gameStatus,
        runtimeEvents: await readJourneyEvents(page),
      };
    }
    if (verdict.restart) {
      restarts += 1;
      playingSince = null;
      await page.click("#restart");
    }
    await page.waitForTimeout(pollMs);
  }
  return {
    result: "timeout",
    restarts,
    ms: Date.now() - startedAt,
    drive: lastTick?.drive ?? null,
    gameStatus: lastTick?.gameStatus ?? null,
    runtimeEvents: await readJourneyEvents(page),
  };
}
