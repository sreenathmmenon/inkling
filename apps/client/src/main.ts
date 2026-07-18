import Phaser from "phaser";

import {
  createPlatformerPlan,
  createObjectiveContract,
  launchPlatformer,
  resolvePlayableGame,
  setPlatformerControl,
  type PlatformerControl,
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
const progressTime = requireElement<HTMLElement>("#progress-time");
const cancelGeneration = requireElement<HTMLButtonElement>("#cancel-generation");
const playToolbar = requireElement<HTMLElement>("#play-toolbar");
const objectiveTitle = requireElement<HTMLElement>("#objective-title");
const objectiveDetail = requireElement<HTMLElement>("#objective-detail");
const gameShell = requireElement<HTMLElement>("#game-shell");
const fullscreenGame = requireElement<HTMLButtonElement>("#fullscreen-game");
const makeAnother = requireElement<HTMLButtonElement>("#make-another");
const postPlayActions = requireElement<HTMLElement>("#post-play-actions");
const accessibleControls = requireElement<HTMLElement>("#accessible-controls");

// The standalone player may replace this at build time; the local capture
// server intentionally does not need Vite's websocket client to do so.
const initialGameSpec = typeof __INKLING_GAMESPEC__ === "undefined"
  ? null
  : __INKLING_GAMESPEC__;
let currentSpec: unknown = initialGameSpec;
let game: Phaser.Game | undefined;
let preparedDrawing: PreparedDrawing | undefined;
let generationProgressTimer: number | undefined;
let generationStartedAt = 0;
let activeCounterLabel: "Bonus" | "Found" | null = null;
let generationSequence = 0;
let activeGeneration: { controller: AbortController; sequence: number } | undefined;

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
    status.textContent = "You made it! Play again or make another game.";
    return;
  }
  if (state.status === "lost") {
    status.textContent = "No lives left. Tap the game message or Restart game to try again.";
    return;
  }
  const collectibles = state.collectibleTotal
    ? ` · ${activeCounterLabel ?? "Found"} ${state.collected}/${state.collectibleTotal}`
    : "";
  status.textContent = `Lives ${state.lives}${collectibles}`;
}

function enterPlayMode(): void {
  document.body.classList.add("play-mode");
  playToolbar.hidden = false;
  window.requestAnimationFrame(() => {
    // Keep the compact objective and the complete control-bearing canvas in
    // one initial viewport. Scrolling to the canvas itself hides the goal cue
    // immediately above it on small phones.
    playToolbar.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "start",
    });
    parent.focus({ preventScroll: true });
  });
}

function play(spec: unknown): void {
  game?.destroy(true);
  parent.replaceChildren();
  gameEmpty.hidden = true;
  parent.hidden = false;
  gameShell.removeAttribute("aria-label");
  gameShell.setAttribute("aria-labelledby", "objective-title");
  gameShell.setAttribute("aria-describedby", "objective-detail game-status controls-hint");
  restart.disabled = false;
  controlsHint.hidden = false;
  accessibleControls.hidden = false;
  postPlayActions.hidden = false;
  const resolved = resolvePlayableGame(spec).gameSpec;
  const plan = createPlatformerPlan(resolved);
  const objective = createObjectiveContract(plan);
  activeCounterLabel = objective.counterLabel;
  objectiveTitle.textContent = objective.headline;
  objectiveDetail.textContent = objective.instruction;
  controlsHint.textContent = plan.contract.touchControls === "four_way"
    ? "Use the four arrow buttons to steer. On a keyboard, use the arrow keys."
    : "Use left and right, then tap jump. You can tap jump once more in the air.";
  requireElement<HTMLButtonElement>('[data-game-control="down"]').hidden = plan.contract.touchControls !== "four_way";
  requireElement<HTMLButtonElement>('[data-game-control="action"]').hidden = !(
    plan.contract.action === "projectile" && plan.goalKind === "defeat_boss"
  );
  game = launchPlatformer({ parent, gameSpec: spec, onStateChange: showState });
  enterPlayMode();
}

function showGameWaiting(): void {
  game?.destroy(true);
  game = undefined;
  parent.replaceChildren();
  parent.hidden = true;
  gameEmpty.hidden = false;
  restart.disabled = true;
  controlsHint.hidden = true;
  accessibleControls.hidden = true;
  postPlayActions.hidden = true;
  playToolbar.hidden = true;
  gameShell.setAttribute("aria-label", "Game preview");
  gameShell.removeAttribute("aria-labelledby");
  gameShell.setAttribute("aria-describedby", "game-status");
  document.body.classList.remove("play-mode");
  status.dataset.gameState = "waiting";
  status.classList.remove("error");
  status.textContent = "Ready when your drawing is.";
}

function showCaptureStatus(message: string, error = false): void {
  captureStatus.textContent = message;
  captureStatus.classList.toggle("error", error);
}

function forgetPreparedDrawing(message = "Photo removed from this page."): void {
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

function resetProgress(): void {
  stopGenerationProgress();
  progressPanel.hidden = true;
  cancelGeneration.hidden = true;
  progressTitle.textContent = "Getting your game ready";
  progressDetail.textContent = "We will show each real step as it starts.";
  progressTime.textContent = "Just started";
  for (const element of document.querySelectorAll<HTMLElement>(".progress-steps [data-stage]")) {
    element.classList.remove("active", "done");
    element.removeAttribute("aria-current");
  }
}

function cancelActiveGeneration(): void {
  generationSequence += 1;
  activeGeneration?.controller.abort();
  activeGeneration = undefined;
  resetProgress();
  makeGame.disabled = preparedDrawing === undefined;
  makeGame.textContent = "Make my game";
  makeGame.removeAttribute("aria-busy");
  forgetDrawing.disabled = false;
}

/**
 * Atomically ends the old drawing/game session. This is intentionally the one
 * transition used by Make another so stale artwork, model responses, file
 * values, and Phaser listeners cannot leak into the next child's creation.
 */
function startFreshDrawingSession(
  message = "Take a clear photo of your next drawing. No account needed.",
): void {
  cancelActiveGeneration();

  currentSpec = null;
  activeCounterLabel = null;
  showGameWaiting();
  preparedDrawing = undefined;
  drawingInput.value = "";
  fileInput.value = "";
  drawingPreview.removeAttribute("src");
  drawingPreview.hidden = true;
  previewEmpty.hidden = false;
  makeGame.disabled = true;
  makeGame.textContent = "Make my game";
  makeGame.removeAttribute("aria-busy");
  forgetDrawing.disabled = false;
  forgetDrawing.hidden = true;
  saveGame.disabled = true;
  objectiveTitle.textContent = "Game preview";
  objectiveDetail.textContent = "Your game will appear here after you choose a drawing.";
  showCaptureStatus(message);

  window.requestAnimationFrame(() => drawingInput.focus());
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
    if (stepIndex === index) element.setAttribute("aria-current", "step");
    else element.removeAttribute("aria-current");
  }
}

function startGenerationProgress(): void {
  window.clearInterval(generationProgressTimer);
  generationStartedAt = performance.now();
  showGenerationStage("checking");
  cancelGeneration.hidden = false;
  progressTime.textContent = "Just started";
  generationProgressTimer = window.setInterval(() => {
    const seconds = Math.floor((performance.now() - generationStartedAt) / 1_000);
    progressTime.textContent = seconds < 30
      ? `${seconds} seconds so far`
      : `${seconds} seconds so far — still working, and every safety and playability check will finish.`;
  }, 1_000);
}

function stopGenerationProgress(): void {
  window.clearInterval(generationProgressTimer);
  generationProgressTimer = undefined;
  cancelGeneration.hidden = true;
  for (const element of document.querySelectorAll<HTMLElement>(".progress-steps [data-stage]")) {
    element.classList.remove("active");
    element.removeAttribute("aria-current");
  }
}

function errorMessage(code?: string): string {
  if (code === "drawing_not_approved") return "Let’s try a drawing without a real face, name, or personal details.";
  if (code === "game_not_finishable") return "This version was not ready to play. Try a clearer photo or a new drawing.";
  if (code === "generation_busy") return "Lots of games are being made right now. Your photo is still ready—please try again in a moment.";
  if (code === "generation_rate_limited") return "You have made several games quickly. Wait a little, then try again with this photo.";
  if (code === "request_too_large") return "That photo is too large to send. Choose a smaller photo and try again.";
  return "We could not finish this game right now. The drawing was not posted or shared. Please try again.";
}

async function readGenerationStream(
  response: Response,
  isCurrent: () => boolean,
): Promise<unknown> {
  if (!response.body) throw new Error(errorMessage());
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const next = await reader.read();
      if (!isCurrent()) throw new DOMException("Generation cancelled", "AbortError");
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
          if (!isCurrent()) throw new DOMException("Generation cancelled", "AbortError");
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
  // A file input does not fire change when the same file is selected twice.
  // The File object remains usable after clearing the control value.
  fileInput.value = "";
  if (activeGeneration) cancelActiveGeneration();
  try {
    currentSpec = JSON.parse(await file.text()) as unknown;
    play(currentSpec);
    saveGame.disabled = false;
  } catch (error) {
    status.dataset.gameState = "error";
    status.classList.add("error");
    status.textContent = "That saved game could not be opened. Try another Inkling game file.";
    status.focus?.();
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
  drawingInput.value = "";
  if (activeGeneration) cancelActiveGeneration();
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
    showCaptureStatus("Your photo is ready. Tap Make my game, or choose a different photo.");
  } catch (error) {
    showCaptureStatus(error instanceof Error ? error.message : "That drawing could not be prepared.", true);
  }
});

makeGame.addEventListener("click", async () => {
  if (!preparedDrawing) return;
  activeGeneration?.controller.abort();
  const controller = new AbortController();
  const sequence = ++generationSequence;
  activeGeneration = { controller, sequence };
  makeGame.disabled = true;
  makeGame.textContent = "Making game…";
  makeGame.setAttribute("aria-busy", "true");
  forgetDrawing.disabled = true;
  showCaptureStatus("We’re turning your drawing into a game. Keep this page open.");
  startGenerationProgress();
  try {
    const response = await fetch("/api/games/drawing", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        image: preparedDrawing.dataUrl,
      }),
      signal: controller.signal,
    });
    if (sequence !== generationSequence) return;
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
      ? await readGenerationStream(response, () => sequence === generationSequence)
      : (await response.json() as { playableGame?: unknown }).playableGame;
    if (sequence !== generationSequence) return;
    if (!currentSpec) throw new Error(errorMessage());
    play(currentSpec);
    saveGame.disabled = false;
    forgetPreparedDrawing("Your drawing is now a playable game.");
  } catch (error) {
    if (sequence !== generationSequence || controller.signal.aborted) return;
    progressPanel.hidden = true;
    const message = error instanceof Error
      ? error.message
      : "We could not finish this game right now. Please try again.";
    showCaptureStatus(message, true);
    captureStatus.setAttribute("tabindex", "-1");
    captureStatus.focus();
  } finally {
    if (activeGeneration?.sequence === sequence) activeGeneration = undefined;
    if (sequence === generationSequence) {
      stopGenerationProgress();
      makeGame.disabled = preparedDrawing === undefined;
      makeGame.textContent = "Make my game";
      makeGame.removeAttribute("aria-busy");
      forgetDrawing.disabled = false;
    }
  }
});

forgetDrawing.addEventListener("click", () => forgetPreparedDrawing());

cancelGeneration.addEventListener("click", () => {
  if (!activeGeneration) return;
  cancelActiveGeneration();
  makeGame.disabled = preparedDrawing === undefined;
  showCaptureStatus("Stopped. Your photo is still ready whenever you want to try again.");
  makeGame.focus();
});

restart.addEventListener("click", () => {
  restart.blur();
  play(currentSpec);
});

makeAnother.addEventListener("click", () => {
  startFreshDrawingSession();
});

if (!document.fullscreenEnabled) fullscreenGame.hidden = true;
fullscreenGame.addEventListener("click", async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await gameShell.requestFullscreen();
  } catch {
    fullscreenGame.hidden = true;
  }
});

for (const button of accessibleControls.querySelectorAll<HTMLButtonElement>("[data-game-control]")) {
  const control = button.dataset.gameControl as PlatformerControl;
  const release = (): void => setPlatformerControl(game, control, false);
  button.addEventListener("pointerdown", () => setPlatformerControl(game, control, true));
  button.addEventListener("pointerup", release);
  button.addEventListener("pointercancel", release);
  button.addEventListener("pointerleave", release);
  button.addEventListener("click", () => {
    setPlatformerControl(game, control, true);
    window.setTimeout(release, control === "jump" || control === "action" ? 120 : 300);
  });
}
saveGame.disabled = currentSpec === null || currentSpec === undefined;
if (currentSpec === null || currentSpec === undefined) showGameWaiting();
else play(currentSpec);
