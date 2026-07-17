import Phaser from "phaser";

import {
  launchPlatformer,
  type PlatformerState,
} from "../../../packages/runtime/src/index.js";

declare const __INKLING_GAMESPEC__: unknown;

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Lane A player is missing ${selector}`);
  return element;
}

const parent = requireElement<HTMLElement>("#game");
const status = requireElement<HTMLElement>("#game-status");
const fileInput = requireElement<HTMLInputElement>("#spec-file");
const restart = requireElement<HTMLButtonElement>("#restart");

let currentSpec: unknown = __INKLING_GAMESPEC__;
let game: Phaser.Game | undefined;

function showState(state: PlatformerState): void {
  status.dataset.gameState = state.status;
  status.classList.remove("error");
  if (state.status === "won") {
    status.textContent = "You won — the drawing completed its game loop.";
    return;
  }
  if (state.status === "lost") {
    status.textContent = "No lives left. Tap the game message or Restart game to try again.";
    return;
  }
  const collectibles = state.collectibleTotal
    ? ` · collectibles ${state.collected}/${state.collectibleTotal}`
    : "";
  status.textContent = `Playing · lives ${state.lives}${collectibles}`;
}

function play(spec: unknown): void {
  game?.destroy(true);
  parent.replaceChildren();
  game = launchPlatformer({ parent, gameSpec: spec, onStateChange: showState });
  parent.focus();
}

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  try {
    currentSpec = JSON.parse(await file.text()) as unknown;
    play(currentSpec);
  } catch (error) {
    status.dataset.gameState = "error";
    status.classList.add("error");
    status.textContent = `Could not load GameSpec: ${String(error)}`;
  }
});

restart.addEventListener("click", () => {
  restart.blur();
  play(currentSpec);
});
play(currentSpec);
