import Phaser from "phaser";

import type { InputFrame } from "./input-frame.js";
import { launchPlatformer } from "./platformer.js";
import { PLATFORMER_PHYSICS } from "./platformer-physics.js";
import type { RuntimeEvent } from "./runtime-events.js";

export interface BrowserReplayOptions {
  parent: string | HTMLElement;
  gameSpec: unknown;
  inputFrames: readonly InputFrame[];
  maxFrames?: number;
}

/**
 * Replays fixed InputFrames through the production Phaser scene and captures
 * the scene's own semantic events. This function requires a real browser; it
 * has no Node or symbolic-solver fallback.
 */
export function replayPlatformerInBrowser(
  options: BrowserReplayOptions,
): Promise<RuntimeEvent[]> {
  return new Promise((resolve, reject) => {
    const events: RuntimeEvent[] = [];
    const finalInputFrame = options.inputFrames.at(-1)?.frame ?? 0;
    const maxFrames = options.maxFrames ?? finalInputFrame + 180;
    let game: Phaser.Game | undefined;
    let advancing = false;
    let terminal = false;
    const destroyNow = (): void => {
      if (!game) return;
      // Game.destroy() only flags pendingDestroy for the next loop step. This
      // harness put the loop to sleep, so that step never comes and the replay
      // instance would live on as a zombie whose window keyboard listeners
      // preventDefault every captured key — silently killing keyboard input
      // for the real game launched right after certification. Step once so
      // runDestroy executes synchronously and every global listener is gone.
      const zombie = game;
      game = undefined;
      try {
        zombie.destroy(true);
        zombie.step(zombie.loop.now, 0);
      } catch {
        // Destruction best-effort: a partially booted game may throw here,
        // but the flagged destroy still prevents further scene work.
      }
    };
    const startupTimeout = window.setTimeout(() => {
      destroyNow();
      reject(new Error("Production Phaser replay did not start"));
    }, 10_000);

    const finish = (): void => {
      window.clearTimeout(startupTimeout);
      const captured = [...events];
      destroyNow();
      resolve(captured);
    };
    const advance = (): void => {
      if (advancing || !game) return;
      advancing = true;
      try {
        game.loop.sleep();
        let timestamp = game.loop.now;
        const stepMs = PLATFORMER_PHYSICS.fixedStepSeconds * 1_000;
        for (let frame = 0; frame < maxFrames && !terminal; frame += 1) {
          timestamp += stepMs;
          game.step(timestamp, stepMs);
        }
        finish();
      } catch (error) {
        window.clearTimeout(startupTimeout);
        destroyNow();
        reject(error);
      }
    };

    game = launchPlatformer({
      parent: options.parent,
      gameSpec: options.gameSpec,
      inputFrames: options.inputFrames,
      onRuntimeEvent(event) {
        events.push(event);
        terminal = event.state.status === "won" || event.state.status === "lost";
        if (event.sequence === 0) window.setTimeout(advance, 0);
      },
    });
  });
}
