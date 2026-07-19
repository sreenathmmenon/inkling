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
    const startupTimeout = window.setTimeout(() => {
      game?.destroy(true);
      reject(new Error("Production Phaser replay did not start"));
    }, 10_000);

    const finish = (): void => {
      window.clearTimeout(startupTimeout);
      const captured = [...events];
      game?.destroy(true);
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
        game.destroy(true);
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
