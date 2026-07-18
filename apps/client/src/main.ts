import Phaser from "phaser";

import {
  createPlatformerPlan,
  launchPlatformer,
  resolvePlayableGame,
  type PlatformerState,
} from "../../../packages/runtime/src/index.js";
import { prepareDrawing, type PreparedDrawing } from "./drawing-prep.js";

declare const __INKLING_GAMESPEC__: unknown;

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Lane A player is missing ${selector}`);
  return element;
}

const parent = requireElement<HTMLElement>("#game");
const gameEmpty = requireElement<HTMLElement>("#game-empty");
const status = requireElement<HTMLElement>("#game-status");
const fileInput = requireElement<HTMLInputElement>("#spec-file");
const saveGame = requireElement<HTMLButtonElement>("#save-game");
const drawingInput = requireElement<HTMLInputElement>("#drawing-file");
const makeGame = requireElement<HTMLButtonElement>("#make-game");
const captureStatus = requireElement<HTMLElement>("#capture-status");
const drawingPreview = requireElement<HTMLImageElement>("#drawing-preview");
const previewEmpty = requireElement<HTMLElement>("#preview-empty");
const restart = requireElement<HTMLButtonElement>("#restart");
const forgetDrawing = requireElement<HTMLButtonElement>("#forget-drawing");
const controlsHint = requireElement<HTMLElement>("#controls-hint");
const progressPanel = requireElement<HTMLElement>("#progress-panel");
const progressTitle = requireElement<HTMLElement>("#progress-title");
const progressDetail = requireElement<HTMLElement>("#progress-detail");

// The standalone player may replace this at build time; the local capture
// server intentionally does not need Vite's websocket client to do so.
const initialGameSpec = typeof __INKLING_GAMESPEC__ === "undefined"
  ? null
  : __INKLING_GAMESPEC__;
let currentSpec: unknown = initialGameSpec;
let game: Phaser.Game | undefined;
let preparedDrawing: PreparedDrawing | undefined;
let generationProgressTimer: number | undefined;

type GenerationStage = "checking" | "understanding" | "animating" | "testing";
type GenerationEvent = {
  type: "progress" | "complete" | "error";
  stage?: GenerationStage;
  playableGame?: unknown;
  error?: string;
};

const STAGES: Array<{ id: GenerationStage; title: string; detail: string }> = [
  { id: "checking", title: "Checking your drawing", detail: "Making sure it is safe to turn into a game." },
  { id: "understanding", title: "Understanding your world", detail: "Finding your hero, objects, rules, and best game style." },
  { id: "animating", title: "Bringing your art to life", detail: "Keeping your strokes and giving your world motion." },
  { id: "testing", title: "Testing your game", detail: "Making sure your game can really be won." },
];

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
  gameEmpty.hidden = true;
  parent.hidden = false;
  restart.disabled = false;
  controlsHint.hidden = false;
  const resolved = resolvePlayableGame(spec).gameSpec;
  const plan = createPlatformerPlan(resolved);
  controlsHint.textContent = plan.contract.touchControls === "four_way"
    ? "Steer with A/D/W/S or arrow keys — or use the four touch controls."
    : "Move left or right, then tap jump. Tap jump again in the air for an extra boost.";
  game = launchPlatformer({ parent, gameSpec: spec, onStateChange: showState });
  parent.focus();
}

function showGameWaiting(): void {
  game?.destroy(true);
  game = undefined;
  parent.replaceChildren();
  parent.hidden = true;
  gameEmpty.hidden = false;
  restart.disabled = true;
  controlsHint.hidden = true;
  status.dataset.gameState = "waiting";
  status.classList.remove("error");
  status.textContent = "Ready when your drawing is.";
}

function showCaptureStatus(message: string, error = false): void {
  captureStatus.textContent = message;
  captureStatus.classList.toggle("error", error);
}

function forgetPreparedDrawing(message = "The prepared drawing was removed from this browser."): void {
  preparedDrawing = undefined;
  drawingInput.value = "";
  drawingPreview.removeAttribute("src");
  drawingPreview.hidden = true;
  previewEmpty.hidden = false;
  makeGame.disabled = true;
  forgetDrawing.hidden = true;
  progressPanel.hidden = true;
  showCaptureStatus(message);
}

function showGenerationStage(stage: GenerationStage): void {
  const index = STAGES.findIndex((item) => item.id === stage);
  const current = STAGES[index];
  if (!current) return;
  progressPanel.hidden = false;
  progressTitle.textContent = current.title;
  progressDetail.textContent = current.detail;
  for (const element of document.querySelectorAll<HTMLElement>(".progress-steps [data-stage]")) {
    const stepIndex = STAGES.findIndex((item) => item.id === element.dataset.stage);
    element.classList.toggle("done", stepIndex >= 0 && stepIndex < index);
    element.classList.toggle("active", stepIndex === index);
  }
}

function startGenerationProgress(): void {
  window.clearInterval(generationProgressTimer);
  showGenerationStage("checking");
  generationProgressTimer = window.setTimeout(() => {
    progressDetail.textContent = `${progressDetail.textContent} This step can take a moment—keep this page open.`;
    generationProgressTimer = undefined;
  }, 60_000);
}

function stopGenerationProgress(): void {
  window.clearInterval(generationProgressTimer);
  generationProgressTimer = undefined;
}

function errorMessage(code?: string): string {
  if (code === "drawing_not_approved") return "Let’s use a drawing without a face, name, or personal details.";
  if (code === "game_not_finishable") return "We could not make a finishable game from that drawing yet. Try another photo.";
  return "We could not make a game right now. Your prepared drawing stays on this device.";
}

async function readGenerationStream(response: Response): Promise<unknown> {
  if (!response.body) throw new Error(errorMessage());
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) break;
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = rawEvent.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
        if (!data) continue;
        let event: GenerationEvent;
        try {
          event = JSON.parse(data) as GenerationEvent;
        } catch {
          throw new Error(errorMessage());
        }
        if (event.type === "progress" && event.stage) {
          showGenerationStage(event.stage);
          continue;
        }
        if (event.type === "error") throw new Error(errorMessage(event.error));
        if (event.type === "complete" && event.playableGame) return event.playableGame;
      }
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error(errorMessage());
}

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  try {
    currentSpec = JSON.parse(await file.text()) as unknown;
    play(currentSpec);
    saveGame.disabled = false;
  } catch (error) {
    status.dataset.gameState = "error";
    status.classList.add("error");
    status.textContent = `Could not load GameSpec: ${String(error)}`;
  }
});

saveGame.addEventListener("click", () => {
  const data = JSON.stringify(currentSpec, null, 2);
  const blob = new Blob([`${data}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "my-inkling-game.json";
  link.click();
  URL.revokeObjectURL(url);
});

drawingInput.addEventListener("change", async () => {
  const file = drawingInput.files?.[0];
  if (!file) return;
  preparedDrawing = undefined;
  makeGame.disabled = true;
  drawingPreview.hidden = true;
  previewEmpty.hidden = false;
  forgetDrawing.hidden = true;
  progressPanel.hidden = true;
  showCaptureStatus("Cropping your drawing on this device…");
  try {
    preparedDrawing = await prepareDrawing(file);
    drawingPreview.src = preparedDrawing.dataUrl;
    drawingPreview.hidden = false;
    previewEmpty.hidden = true;
    makeGame.disabled = false;
    forgetDrawing.hidden = false;
    showCaptureStatus("Your drawing is ready. Tap Make my game when you are happy with the crop.");
  } catch (error) {
    showCaptureStatus(error instanceof Error ? error.message : "That drawing could not be prepared.", true);
  }
});

makeGame.addEventListener("click", async () => {
  if (!preparedDrawing) return;
  makeGame.disabled = true;
  makeGame.textContent = "Making game…";
  makeGame.setAttribute("aria-busy", "true");
  forgetDrawing.disabled = true;
  showCaptureStatus("We’re turning your drawing into a game. Keep this page open.");
  startGenerationProgress();
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 150_000);
  try {
    const response = await fetch("/api/games/drawing", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      signal: controller.signal,
      body: JSON.stringify({
        image: preparedDrawing.dataUrl,
      }),
    });
    if (!response.ok) {
      let body: { error?: string } = {};
      try {
        body = await response.json() as { error?: string };
      } catch {
        // A misconfigured/restarting service may not return JSON. Do not surface
        // transport details to a child, and never retry/upload automatically.
      }
      throw new Error(errorMessage(body.error));
    }
    currentSpec = response.headers.get("content-type")?.startsWith("text/event-stream")
      ? await readGenerationStream(response)
      : (await response.json() as { playableGame?: unknown }).playableGame;
    if (!currentSpec) throw new Error(errorMessage());
    play(currentSpec);
    saveGame.disabled = false;
    forgetPreparedDrawing("Your drawing is now a playable game. Save it locally if you want to keep it.");
  } catch (error) {
    const message = error instanceof DOMException && error.name === "AbortError"
      ? "This is taking longer than expected. Your drawing is still here—please try Make my game again."
      : error instanceof Error
        ? error.message
        : "We could not make a game right now.";
    showCaptureStatus(message, true);
  } finally {
    window.clearTimeout(timeout);
    stopGenerationProgress();
    makeGame.disabled = preparedDrawing === undefined;
    makeGame.textContent = "Make my game";
    makeGame.removeAttribute("aria-busy");
    forgetDrawing.disabled = false;
  }
});

forgetDrawing.addEventListener("click", () => forgetPreparedDrawing());

restart.addEventListener("click", () => {
  restart.blur();
  play(currentSpec);
});
saveGame.disabled = currentSpec === null || currentSpec === undefined;
if (currentSpec === null || currentSpec === undefined) showGameWaiting();
else play(currentSpec);
