import {
  attachRuntimeTraceReport,
  resolvePlayableGame,
} from "../../../packages/runtime/src/artwork.js";
import { createPlatformerPlan } from "../../../packages/runtime/src/platformer-layout.js";
import { createObjectiveContract } from "../../../packages/runtime/src/objective-contract.js";
import type {
  PlatformerControl,
  PlatformerState,
} from "../../../packages/runtime/src/platformer.js";
import type { RuntimeEvent } from "../../../packages/runtime/src/runtime-events.js";
import type { InputFrame } from "../../../packages/runtime/src/input-frame.js";
import type Phaser from "phaser";
import type { GameSpec } from "../../../runner/types.js";
import { runPlaytestWithTrace } from "../../../services/solve/src/playtest.js";
import { validateRuntimeTrace } from "../../../services/solve/src/runtime-trace.js";
import {
  prepareDrawing,
  type DrawingAdjustment,
  type DrawingQualityWarning,
  type PreparedDrawing,
} from "./drawing-prep.js";
import {
  generationErrorMessage,
  visibleGenerationFailure,
} from "./generation-copy.js";
import { attachMotionDelight } from "./motion-delight.js";
import {
  appendCorrection,
  assumptionChips,
  interpretationNoteText,
  type CertificationOutcome,
} from "./interpretation-status.js";
import { freshPlayerState, shouldShowAssist } from "./player-status.js";
import { attachSoundFeedback } from "./sound-feedback.js";

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
const adjustPicture = requireElement<HTMLButtonElement>("#adjust-picture");
const pictureAdjuster = requireElement<HTMLElement>("#picture-adjuster");
const finishPicture = requireElement<HTMLButtonElement>("#finish-picture");
const resetPicture = requireElement<HTMLButtonElement>("#reset-picture");
const rotatePictureLeft = requireElement<HTMLButtonElement>("#rotate-picture-left");
const rotatePictureRight = requireElement<HTMLButtonElement>("#rotate-picture-right");
const straightenPicture = requireElement<HTMLInputElement>("#adjust-straighten");
const trimLeft = requireElement<HTMLInputElement>("#adjust-left");
const trimRight = requireElement<HTMLInputElement>("#adjust-right");
const trimTop = requireElement<HTMLInputElement>("#adjust-top");
const trimBottom = requireElement<HTMLInputElement>("#adjust-bottom");
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
const interpretationNote = requireElement<HTMLElement>("#interpretation-note");
const gameShell = requireElement<HTMLElement>("#game-shell");
const fullscreenGame = requireElement<HTMLButtonElement>("#fullscreen-game");
const fullscreenNewDrawing = requireElement<HTMLButtonElement>("#fullscreen-new-drawing");
const makeAnother = requireElement<HTMLButtonElement>("#make-another");
const postPlayActions = requireElement<HTMLElement>("#post-play-actions");
const assistGame = requireElement<HTMLButtonElement>("#assist-game");
const accessibleControls = requireElement<HTMLElement>("#accessible-controls");
const runtimeReplayHost = requireElement<HTMLElement>("#runtime-replay-host");
const safeOfferPanel = requireElement<HTMLElement>("#safe-offer-panel");
const safeOfferTitle = requireElement<HTMLElement>("#safe-offer-title");
const safeOfferDetail = requireElement<HTMLElement>("#safe-offer-detail");
const assumptionChipList = requireElement<HTMLElement>("#assumption-chips");
const playSafeVersion = requireElement<HTMLButtonElement>("#play-safe-version");
const tryNewPicture = requireElement<HTMLButtonElement>("#try-new-picture");
const capturePanel = requireElement<HTMLElement>("#capture-panel");
const playStage = requireElement<HTMLElement>("#play-stage");
const returnGame = requireElement<HTMLButtonElement>("#return-game");
const saveStatus = requireElement<HTMLElement>("#save-status");
const previewStage = requireElement<HTMLElement>(".preview-stage");
const soundToggle = requireElement<HTMLButtonElement>("#sound-toggle");

const motionDelight = attachMotionDelight({
  shell: gameShell,
  status,
  controls: accessibleControls,
  actions: postPlayActions,
});
const soundFeedback = attachSoundFeedback({ button: soundToggle });

// The standalone player may replace this at build time; the local capture
// server intentionally does not need Vite's websocket client to do so.
const initialGameSpec = typeof __INKLING_GAMESPEC__ === "undefined"
  ? null
  : __INKLING_GAMESPEC__;
let currentSpec: unknown = initialGameSpec;
let game: Phaser.Game | undefined;
let playSequence = 0;
let playerModule: typeof import("../../../packages/runtime/src/platformer.js") | undefined;
let playerModulePromise: Promise<typeof import("../../../packages/runtime/src/platformer.js")> | undefined;
let playerLoadAttempt = 0;
let preparedDrawing: PreparedDrawing | undefined;
let sourceDrawingFile: File | undefined;
let preparationSequence = 0;
let pictureQuarterTurns = 0;
let generationProgressTimer: number | undefined;
let generationStartedAt = 0;
let activeCounterLabel: "Bonus" | "Found" | null = null;
let generationSequence = 0;
let activeGeneration: { controller: AbortController; sequence: number } | undefined;
let pendingPlayableGame: unknown;
let generationStageIndex = -1;
let returnableGame: unknown;
let saveFeedbackTimer: number | undefined;
let pendingCorrections: string[] = [];
let lastCertification: CertificationOutcome = "not_applicable";
const gameControlReleases: Array<() => void> = [];

function releaseAllGameControls(): void {
  for (const release of gameControlReleases) release();
}

// "safe-offer" is the PlayContract needs_recast surface (offer to play the
// certified safe version). It is deliberately named apart from the pipeline's
// P8 safety-recast ladder, which is a different mechanism.
type ExperienceState = "capture-empty" | "capture-ready" | "generating" | "safe-offer" | "playing" | "won" | "lost" | "player-error";
const EXPERIENCE_STATES: readonly ExperienceState[] = [
  "capture-empty", "capture-ready", "generating", "safe-offer", "playing", "won", "lost", "player-error",
];

function renderExperienceState(state: ExperienceState): void {
  document.body.classList.remove(...EXPERIENCE_STATES);
  document.body.classList.add(state);
  document.body.classList.toggle("has-drawing", state === "capture-ready" || state === "generating" || state === "safe-offer");
  document.body.classList.toggle("generating", state === "generating");
  document.body.classList.toggle("game-won", state === "won");
  document.body.classList.toggle("game-lost", state === "lost");
}

type GenerationStage = "checking" | "understanding" | "animating" | "testing";
type GenerationEvent = {
  type: "progress" | "complete" | "error";
  requestId?: string;
  stage?: GenerationStage;
  playableGame?: unknown;
  error?: string;
};

declare global {
  interface Window {
    __INKLING_REPLAY__?: {
      run(gameSpec: unknown, inputFrames: readonly InputFrame[]): Promise<RuntimeEvent[]>;
    };
  }
}

const STAGES: Array<{ id: GenerationStage; title: string; detail: string }> = [
  { id: "checking", title: "Picture looks good", detail: "Keeping every original line and color safe." },
  { id: "understanding", title: "Meeting your world", detail: "Finding the hero, paths, surprises, and goal." },
  { id: "animating", title: "Adding game magic", detail: "Giving your drawing movement and real game rules." },
  { id: "testing", title: "Playing it through", detail: "Making sure your adventure can be finished." },
];

function loadPlayer(): Promise<typeof import("../../../packages/runtime/src/platformer.js")> {
  if (playerModule) return Promise.resolve(playerModule);
  if (playerModulePromise) return playerModulePromise;
  const load = playerLoadAttempt++ === 0
    ? import("../../../packages/runtime/src/platformer.js")
    // A failed module fetch is cached for the lifetime of the document. The
    // retry identity lets a child recover in place when connectivity returns.
    // @ts-expect-error Vite treats this query as a distinct retry module.
    : import("../../../packages/runtime/src/platformer.js?retry");
  playerModulePromise = load.then((loaded) => {
    playerModule = loaded;
    return loaded;
  }).catch((error: unknown) => {
    playerModulePromise = undefined;
    throw error;
  });
  return playerModulePromise;
}

async function replayInProduction(
  gameSpec: unknown,
  inputFrames: readonly InputFrame[],
  host: HTMLElement,
): Promise<RuntimeEvent[]> {
  const { replayPlatformerInBrowser } = await import("../../../packages/runtime/src/browser-replay.js");
  return replayPlatformerInBrowser({ parent: host, gameSpec, inputFrames });
}

if (new URLSearchParams(window.location.search).has("runtime-replay")) {
  document.body.classList.add("runtime-replay-mode");
  window.__INKLING_REPLAY__ = {
    run(gameSpec, inputFrames) {
      return replayInProduction(gameSpec, inputFrames, parent);
    },
  };
}

async function certifyGeneratedGame(
  value: unknown,
): Promise<{ value: unknown; certification: CertificationOutcome }> {
  const playable = resolvePlayableGame(value);
  if (!playable.playContract || playable.playContract.outcome !== "faithful_ready") {
    return { value, certification: "not_applicable" };
  }
  try {
    const gameSpec = playable.gameSpec as GameSpec;
    const analytic = runPlaytestWithTrace(gameSpec);
    if (!analytic.report.reached_goal) return { value, certification: "unverified" };
    const events = await replayInProduction(gameSpec, analytic.inputFrames, runtimeReplayHost);
    const report = validateRuntimeTrace(events, playable.playContract);
    return {
      value: attachRuntimeTraceReport(value, report),
      certification: report.valid ? "certified" : "unverified",
    };
  } catch {
    // Lane A remains playable, but the child is told rather than shown a
    // silently-normal game: an unverified result never celebrates as if the
    // full runtime check had passed, and sharing stays blocked.
    return { value, certification: "unverified" };
  }
}

function showState(state: PlatformerState): void {
  const assistVisible = shouldShowAssist(state);
  assistGame.hidden = !assistVisible;
  soundToggle.hidden = state.status !== "playing";
  document.body.classList.toggle("assist-available", assistVisible);
  status.dataset.gameState = state.status;
  status.classList.remove("error");
  if (state.status === "won") {
    renderExperienceState("won");
    restart.hidden = false;
    saveGame.hidden = false;
    status.textContent = "You brought it to life! What will you make next?";
    // An unverified game never celebrates as though the full runtime check
    // passed; the win still counts, the flourish waits for a verified one.
    if (lastCertification !== "unverified") motionDelight.stateChanged(state.status);
    restart.focus({ preventScroll: true });
    return;
  }
  if (state.status === "lost") {
    renderExperienceState("lost");
    restart.hidden = false;
    status.textContent = "No lives left. Tap Play again to try again.";
    motionDelight.stateChanged(state.status);
    restart.focus({ preventScroll: true });
    return;
  }
  renderExperienceState("playing");
  const collectibles = state.collectibleTotal
    ? ` · ${activeCounterLabel ?? "Found"} ${state.collected}/${state.collectibleTotal}`
    : "";
  status.textContent = `Lives ${state.lives}${collectibles}${state.assistActive ? " · Help boost on" : ""}`;
}

function enterPlayMode(state: "playing" | "player-error" = "playing", focusTarget: HTMLElement = parent): void {
  document.body.classList.add("play-mode");
  renderExperienceState(state);
  playToolbar.hidden = false;
  window.requestAnimationFrame(() => {
    // Keep the compact objective and the complete control-bearing canvas in
    // one initial viewport. Scrolling to the canvas itself hides the goal cue
    // immediately above it on small phones.
    playToolbar.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "start",
    });
    focusTarget.focus({ preventScroll: true });
  });
}

async function play(spec: unknown): Promise<void> {
  const sequence = ++playSequence;
  releaseAllGameControls();
  game?.destroy(true);
  game = undefined;
  parent.replaceChildren();
  gameEmpty.hidden = true;
  parent.hidden = false;
  gameShell.removeAttribute("aria-label");
  gameShell.setAttribute("aria-labelledby", "objective-title");
  gameShell.setAttribute("aria-describedby", "objective-detail game-status controls-hint game-control-help");
  restart.disabled = false;
  restart.hidden = true;
  saveGame.hidden = true;
  controlsHint.hidden = false;
  accessibleControls.hidden = false;
  postPlayActions.hidden = false;
  const playable = resolvePlayableGame(spec);
  const plan = createPlatformerPlan(playable.gameSpec);
  const objective = createObjectiveContract(plan);
  document.body.classList.toggle("four-way-controls", plan.contract.touchControls === "four_way");
  activeCounterLabel = objective.counterLabel;
  // A replay creates a fresh Phaser instance, so its visible status must also
  // start from a fresh playing state. Do this before the lazy player loads;
  // otherwise the previous win/loss announcement can remain on screen even
  // though the new game is already accepting input.
  showState(freshPlayerState(plan));
  objectiveTitle.textContent = objective.headline;
  objectiveDetail.textContent = objective.instruction;
  const specForNotices = playable.gameSpec as GameSpec | undefined;
  const noteText = interpretationNoteText(
    playable.readinessOutcome,
    Array.isArray(specForNotices?.flags) ? specForNotices.flags : [],
    lastCertification,
  );
  interpretationNote.hidden = noteText === "";
  interpretationNote.textContent = noteText;
  document.body.classList.toggle("game-unverified", lastCertification === "unverified");
  renderAssumptionChips(specForNotices);
  controlsHint.textContent = plan.contract.touchControls === "four_way"
    ? "Use the four arrow buttons to steer. On a keyboard, use the arrow keys."
    : "Use left and right, then tap jump. You can tap jump once more in the air.";
  requireElement<HTMLButtonElement>('[data-game-control="down"]').hidden = plan.contract.touchControls !== "four_way";
  requireElement<HTMLButtonElement>('[data-game-control="action"]').hidden = !(
    plan.contract.action === "projectile" && plan.goalKind === "defeat_boss"
  );
  accessibleControls.dataset.layout = plan.contract.touchControls === "four_way" ? "four-way" : "side";
  accessibleControls.dataset.hasAction = String(!requireElement<HTMLButtonElement>('[data-game-control="action"]').hidden);
  const jumpControlLabel = requireElement<HTMLElement>('[data-game-control="jump"] span');
  jumpControlLabel.textContent = plan.contract.touchControls === "four_way" ? "Up" : "Jump";
  let launchPlatformer: typeof import("../../../packages/runtime/src/platformer.js").launchPlatformer;
  try {
    ({ launchPlatformer } = await loadPlayer());
  } catch {
    if (sequence !== playSequence) return;
    parent.hidden = true;
    gameEmpty.hidden = false;
    gameEmpty.querySelector("h2")!.textContent = "Your game needs one more try";
    gameEmpty.querySelector("p")!.textContent = "Tap Play again. Your drawing and game are still here.";
    status.dataset.gameState = "error";
    status.classList.add("error");
    status.textContent = "The player did not finish opening. Tap Play again.";
    soundToggle.hidden = true;
    restart.hidden = false;
    restart.disabled = false;
    enterPlayMode("player-error", restart);
    return;
  }
  if (sequence !== playSequence) return;
  game = launchPlatformer({
    parent,
    gameSpec: spec,
    showTouchControls: false,
    presentation: "embedded",
    onStateChange: showState,
    onRuntimeEvent(event: RuntimeEvent) {
      motionDelight.handleRuntimeEvent(event);
      soundFeedback.handleRuntimeEvent(event);
      window.dispatchEvent(new CustomEvent<RuntimeEvent>("inkling:runtime-event", { detail: event }));
    },
  });
  motionDelight.gameRevealed();
  enterPlayMode();
}

/**
 * Renders the model's child-readable guesses as correctable chips. A chip tap
 * rejects that guess and re-derives the whole game through every ordered gate
 * with the correction as context — possible only while the drawing is still
 * held on this page.
 */
function renderAssumptionChips(spec: GameSpec | undefined): void {
  assumptionChipList.replaceChildren();
  const guesses = spec && Array.isArray(spec.assumptions) ? assumptionChips(spec.assumptions) : [];
  const canCorrect = preparedDrawing !== undefined && guesses.length > 0;
  assumptionChipList.hidden = !canCorrect;
  if (!canCorrect) return;
  for (const guess of guesses) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "assumption-chip";
    button.textContent = `${guess} — Not right? Tap to fix it.`;
    button.addEventListener("click", () => {
      if (!preparedDrawing || activeGeneration) return;
      pendingCorrections = appendCorrection(pendingCorrections, guess);
      showGameWaiting();
      void runGeneration();
    });
    item.append(button);
    assumptionChipList.append(item);
  }
}

function showGameWaiting(): void {
  playSequence += 1;
  releaseAllGameControls();
  game?.destroy(true);
  game = undefined;
  parent.replaceChildren();
  parent.hidden = true;
  gameEmpty.hidden = false;
  restart.disabled = true;
  controlsHint.hidden = true;
  accessibleControls.hidden = true;
  postPlayActions.hidden = true;
  assistGame.hidden = true;
  playToolbar.hidden = true;
  interpretationNote.hidden = true;
  interpretationNote.textContent = "";
  assumptionChipList.hidden = true;
  assumptionChipList.replaceChildren();
  document.body.classList.remove("game-unverified");
  gameShell.setAttribute("aria-label", "Game preview");
  gameShell.removeAttribute("aria-labelledby");
  gameShell.setAttribute("aria-describedby", "game-status");
  document.body.classList.remove("play-mode");
  renderExperienceState("capture-empty");
  status.dataset.gameState = "waiting";
  status.classList.remove("error");
  status.textContent = "Ready when your drawing is.";
}

function showCaptureStatus(message: string, error = false): void {
  captureStatus.textContent = message;
  captureStatus.classList.toggle("error", error);
}

const QUALITY_COPY: Record<DrawingQualityWarning, string> = {
  page_edge_uncertain: "Check that the preview contains only the drawing",
  low_contrast: "The marks may be hard to see",
  content_near_edge: "Some marks are close to the edge",
  blurry: "The photo looks a little blurry",
  uneven_lighting: "A shadow or bright patch may hide some marks",
  page_skewed: "The page looks tilted",
};

function captureReviewMessage(warnings: readonly DrawingQualityWarning[]): string {
  if (!warnings.length) return "Your drawing is ready. Make the game, or adjust the crop if you want to.";
  const details = warnings.slice(0, 2).map((warning) => QUALITY_COPY[warning]);
  return `Your drawing is ready! ${details.join("; ")}. Adjust the picture if anything looks cut off, or keep going.`;
}

function rangeNumber(input: HTMLInputElement): number {
  const value = Number(input.value);
  return Number.isFinite(value) ? value : 0;
}

function updateAdjustmentOutputs(): void {
  for (const input of [straightenPicture, trimLeft, trimRight, trimTop, trimBottom]) {
    const output = document.querySelector<HTMLOutputElement>(`output[for="${input.id}"]`);
    if (output) output.value = `${input === straightenPicture ? rangeNumber(input) : Math.round(rangeNumber(input))}${input === straightenPicture ? "°" : "%"}`;
  }
}

function currentDrawingAdjustment(): DrawingAdjustment {
  return {
    rotationDegrees: pictureQuarterTurns * 90 + rangeNumber(straightenPicture),
    cropInsets: {
      left: rangeNumber(trimLeft) / 100,
      right: rangeNumber(trimRight) / 100,
      top: rangeNumber(trimTop) / 100,
      bottom: rangeNumber(trimBottom) / 100,
    },
  };
}

function resetAdjustmentControls(): void {
  pictureQuarterTurns = 0;
  for (const input of [straightenPicture, trimLeft, trimRight, trimTop, trimBottom]) input.value = "0";
  updateAdjustmentOutputs();
}

async function updatePreparedPicture(message: string, focusReview = false): Promise<void> {
  const file = sourceDrawingFile;
  if (!file) return;
  const sequence = ++preparationSequence;
  preparedDrawing = undefined;
  makeGame.disabled = true;
  showCaptureStatus(message);
  try {
    const result = await prepareDrawing(file, currentDrawingAdjustment());
    if (sequence !== preparationSequence || sourceDrawingFile !== file) return;
    preparedDrawing = result;
    drawingPreview.src = result.dataUrl;
    drawingPreview.hidden = false;
    previewEmpty.hidden = true;
    adjustPicture.hidden = false;
    forgetDrawing.hidden = false;
    makeGame.disabled = false;
    returnableGame = undefined;
    returnGame.hidden = true;
    renderExperienceState("capture-ready");
    showCaptureStatus(captureReviewMessage(result.quality.warnings));
    if (focusReview && (window.innerWidth <= 760 || window.innerHeight <= 600)) {
      window.requestAnimationFrame(() => previewStage.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "start",
      }));
    }
  } catch (error) {
    if (sequence !== preparationSequence) return;
    renderExperienceState("capture-empty");
    showCaptureStatus(error instanceof Error ? error.message : "That drawing could not be prepared.", true);
  }
}

function forgetPreparedDrawing(message = "Photo removed from this page."): void {
  pendingCorrections = [];
  preparationSequence += 1;
  preparedDrawing = undefined;
  sourceDrawingFile = undefined;
  drawingInput.value = "";
  drawingPreview.removeAttribute("src");
  drawingPreview.hidden = true;
  previewEmpty.hidden = false;
  makeGame.disabled = true;
  adjustPicture.hidden = true;
  pictureAdjuster.hidden = true;
  safeOfferPanel.hidden = true;
  pendingPlayableGame = undefined;
  forgetDrawing.hidden = true;
  progressPanel.hidden = true;
  renderExperienceState("capture-empty");
  showCaptureStatus(message);
}

function resetProgress(): void {
  stopGenerationProgress();
  progressPanel.hidden = true;
  cancelGeneration.hidden = true;
  progressTitle.textContent = "Waking up your world";
  progressDetail.textContent = "Your drawing stays right here while every game step is built and tested.";
  progressTime.textContent = "Just started";
  generationStageIndex = -1;
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
  renderExperienceState(preparedDrawing ? "capture-ready" : "capture-empty");
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
  pendingPlayableGame = undefined;
  pendingCorrections = [];
  lastCertification = "not_applicable";
  activeCounterLabel = null;
  showGameWaiting();
  preparedDrawing = undefined;
  sourceDrawingFile = undefined;
  preparationSequence += 1;
  drawingInput.value = "";
  fileInput.value = "";
  drawingPreview.removeAttribute("src");
  drawingPreview.hidden = true;
  previewEmpty.hidden = false;
  makeGame.disabled = true;
  makeGame.textContent = "Make my game";
  makeGame.removeAttribute("aria-busy");
  adjustPicture.hidden = true;
  pictureAdjuster.hidden = true;
  safeOfferPanel.hidden = true;
  resetAdjustmentControls();
  forgetDrawing.disabled = false;
  forgetDrawing.hidden = true;
  saveGame.disabled = true;
  objectiveTitle.textContent = "Game preview";
  objectiveDetail.textContent = "Your game will appear here after you choose a drawing.";
  showCaptureStatus(message);
  returnGame.hidden = returnableGame === undefined;
  renderExperienceState("capture-empty");

  window.requestAnimationFrame(() => drawingInput.focus());
}

function showGenerationStage(stage: GenerationStage): void {
  const index = STAGES.findIndex((item) => item.id === stage);
  const current = STAGES[index];
  if (!current || index < generationStageIndex) return;
  generationStageIndex = index;
  progressPanel.hidden = false;
  progressTitle.textContent = current.title;
  progressDetail.textContent = current.detail;
  let activeStep: HTMLElement | undefined;
  for (const element of document.querySelectorAll<HTMLElement>(".progress-steps [data-stage]")) {
    const stepIndex = STAGES.findIndex((item) => item.id === element.dataset.stage);
    element.classList.toggle("done", stepIndex >= 0 && stepIndex < index);
    element.classList.toggle("active", stepIndex === index);
    if (stepIndex === index) {
      element.setAttribute("aria-current", "step");
      activeStep = element;
    }
    else element.removeAttribute("aria-current");
  }
  if (activeStep) motionDelight.generationStageChanged(activeStep);
}

function startGenerationProgress(): void {
  window.clearInterval(generationProgressTimer);
  generationStageIndex = -1;
  generationStartedAt = performance.now();
  showGenerationStage("checking");
  renderExperienceState("generating");
  // Phaser is the large lazy chunk. Load it while the real model pipeline is
  // running so the reveal can begin immediately when the certified game lands.
  void loadPlayer().catch(() => undefined);
  cancelGeneration.hidden = false;
  progressTime.textContent = "Just started";
  window.requestAnimationFrame(() => {
    if (window.innerWidth <= 760 || window.innerHeight <= 600) {
      capturePanel.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "start",
      });
    }
    progressPanel.focus({ preventScroll: true });
  });
  generationProgressTimer = window.setInterval(() => {
    const seconds = Math.floor((performance.now() - generationStartedAt) / 1_000);
    progressTime.textContent = seconds < 30
      ? `Magic in motion · ${seconds} seconds`
      : `Still bringing it together · ${seconds} seconds`;
  }, 2_000);
}

function newRequestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `inkling-${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
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

async function readGenerationStream(
  response: Response,
  isCurrent: () => boolean,
  expectedRequestId: string,
): Promise<unknown> {
  if (!response.body) throw new Error(generationErrorMessage());
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
          throw new Error(generationErrorMessage());
        }
        if (event.requestId !== expectedRequestId) throw new Error(generationErrorMessage());
        if (event.type === "progress" && event.stage) {
          if (!isCurrent()) throw new DOMException("Generation cancelled", "AbortError");
          showGenerationStage(event.stage);
          continue;
        }
        if (event.type === "error") throw new Error(generationErrorMessage(event.error));
        if (event.type === "complete" && event.playableGame) return event.playableGame;
      }
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error(generationErrorMessage());
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
    showCaptureStatus("That saved game could not be opened. Try another Inkling game file.", true);
    if (document.body.classList.contains("play-mode")) status.focus();
    else {
      capturePanel.scrollIntoView({ behavior: "smooth", block: "start" });
      captureStatus.setAttribute("tabindex", "-1");
      captureStatus.focus({ preventScroll: true });
    }
  }
});

saveGame.addEventListener("click", () => {
  try {
    const data = JSON.stringify(currentSpec, null, 2);
    const blob = new Blob([`${data}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "my-inkling-game.json";
    link.click();
    // Safari can consume the object URL after the click task completes.
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    window.clearTimeout(saveFeedbackTimer);
    saveGame.textContent = "Download started";
    saveStatus.textContent = "Your game download started.";
    saveFeedbackTimer = window.setTimeout(() => {
      saveGame.textContent = "Save";
      saveStatus.textContent = "";
      saveFeedbackTimer = undefined;
    }, 2_500);
  } catch {
    saveStatus.textContent = "The download did not start. Tap Save game to try again.";
  }
});

drawingInput.addEventListener("change", async () => {
  const file = drawingInput.files?.[0];
  if (!file) return;
  drawingInput.value = "";
  if (activeGeneration) cancelActiveGeneration();
  preparationSequence += 1;
  preparedDrawing = undefined;
  sourceDrawingFile = file;
  resetAdjustmentControls();
  makeGame.disabled = true;
  drawingPreview.hidden = true;
  previewEmpty.hidden = false;
  forgetDrawing.hidden = true;
  adjustPicture.hidden = true;
  pictureAdjuster.hidden = true;
  safeOfferPanel.hidden = true;
  pendingPlayableGame = undefined;
  progressPanel.hidden = true;
  renderExperienceState("capture-empty");
  await updatePreparedPicture("Preparing your drawing on this device…", true);
});

adjustPicture.addEventListener("click", () => {
  if (!sourceDrawingFile) return;
  pictureAdjuster.hidden = false;
  adjustPicture.setAttribute("aria-expanded", "true");
  straightenPicture.focus();
});

finishPicture.addEventListener("click", () => {
  pictureAdjuster.hidden = true;
  adjustPicture.setAttribute("aria-expanded", "false");
  if (!preparedDrawing) return;
  makeGame.disabled = false;
  showCaptureStatus(captureReviewMessage(preparedDrawing.quality.warnings));
  adjustPicture.focus();
});

for (const input of [straightenPicture, trimLeft, trimRight, trimTop, trimBottom]) {
  input.addEventListener("input", updateAdjustmentOutputs);
  input.addEventListener("change", () => void updatePreparedPicture("Updating your preview on this device…"));
}

rotatePictureLeft.addEventListener("click", () => {
  pictureQuarterTurns -= 1;
  void updatePreparedPicture("Rotating your preview on this device…");
});

rotatePictureRight.addEventListener("click", () => {
  pictureQuarterTurns += 1;
  void updatePreparedPicture("Rotating your preview on this device…");
});

resetPicture.addEventListener("click", () => {
  resetAdjustmentControls();
  void updatePreparedPicture("Resetting your preview on this device…");
});

async function runGeneration(): Promise<void> {
  if (!preparedDrawing) return;
  activeGeneration?.controller.abort();
  const controller = new AbortController();
  const sequence = ++generationSequence;
  const requestId = newRequestId();
  safeOfferPanel.hidden = true;
  pendingPlayableGame = undefined;
  activeGeneration = { controller, sequence };
  makeGame.disabled = true;
  makeGame.textContent = "Making game…";
  makeGame.setAttribute("aria-busy", "true");
  forgetDrawing.disabled = true;
  showCaptureStatus(
    pendingCorrections.length > 0
      ? "Got it — trying your drawing again with your fix."
      : "We’re turning your drawing into a game. Keep this page open.",
  );
  startGenerationProgress();
  try {
    const response = await fetch("/api/games/drawing", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        image: preparedDrawing.dataUrl,
        request_id: requestId,
        ...(pendingCorrections.length > 0 ? { corrections: pendingCorrections } : {}),
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
      throw new Error(generationErrorMessage(body.error));
    }
    if (response.headers.get("content-type")?.startsWith("text/event-stream")) {
      currentSpec = await readGenerationStream(response, () => sequence === generationSequence, requestId);
    } else {
      const result = await response.json() as { requestId?: string; playableGame?: unknown };
      if (result.requestId !== requestId) throw new Error(generationErrorMessage());
      currentSpec = result.playableGame;
    }
    if (sequence !== generationSequence) return;
    if (!currentSpec) throw new Error(generationErrorMessage());
    const certified = await certifyGeneratedGame(currentSpec);
    if (sequence !== generationSequence) return;
    currentSpec = certified.value;
    lastCertification = certified.certification;
    const playable = resolvePlayableGame(currentSpec);
    if (playable.readinessOutcome === "needs_recast") {
      pendingPlayableGame = currentSpec;
      progressPanel.hidden = true;
      safeOfferPanel.hidden = false;
      renderExperienceState("safe-offer");
      safeOfferTitle.textContent = "Your world is ready";
      safeOfferDetail.textContent = "Your art stayed yours. Inkling chose a clear adventure you can finish.";
      showCaptureStatus("Your playable version is ready.");
      playSafeVersion.focus();
    } else {
      play(currentSpec);
      saveGame.disabled = false;
      // The drawing stays on this page (never re-uploaded on its own) so a
      // chip tap can correct a guess; Forget drawing and Make another still
      // clear it the moment the child chooses.
      progressPanel.hidden = true;
      showCaptureStatus("Your drawing became a game! It stays here in case you want to fix a guess.");
    }
  } catch (error) {
    if (sequence !== generationSequence || controller.signal.aborted) return;
    progressPanel.hidden = true;
    showCaptureStatus(visibleGenerationFailure(error), true);
    captureStatus.setAttribute("tabindex", "-1");
    captureStatus.focus();
    renderExperienceState(preparedDrawing ? "capture-ready" : "capture-empty");
  } finally {
    if (activeGeneration?.sequence === sequence) activeGeneration = undefined;
    if (sequence === generationSequence) {
      stopGenerationProgress();
      makeGame.disabled = preparedDrawing === undefined || pendingPlayableGame !== undefined;
      makeGame.textContent = "Make my game";
      makeGame.removeAttribute("aria-busy");
      forgetDrawing.disabled = false;
    }
  }
}

makeGame.addEventListener("click", () => {
  pendingCorrections = [];
  void runGeneration();
});

playSafeVersion.addEventListener("click", () => {
  if (pendingPlayableGame === undefined) return;
  currentSpec = pendingPlayableGame;
  pendingPlayableGame = undefined;
  play(currentSpec);
  saveGame.disabled = false;
  forgetPreparedDrawing("Your drawing is now a playable game.");
});

tryNewPicture.addEventListener("click", () => startFreshDrawingSession());

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

assistGame.addEventListener("click", () => {
  playerModule?.requestPlatformerAssist(game);
  assistGame.hidden = true;
  parent.focus({ preventScroll: true });
});

async function startAnotherDrawing(): Promise<void> {
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
  returnableGame = currentSpec;
  startFreshDrawingSession();
}

makeAnother.addEventListener("click", () => void startAnotherDrawing());
fullscreenNewDrawing.addEventListener("click", () => void startAnotherDrawing());

returnGame.addEventListener("click", () => {
  if (returnableGame === undefined) return;
  currentSpec = returnableGame;
  returnableGame = undefined;
  returnGame.hidden = true;
  void play(currentSpec);
});

if (!document.fullscreenEnabled) fullscreenGame.hidden = true;
fullscreenGame.addEventListener("click", async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await playStage.requestFullscreen();
  } catch {
    fullscreenGame.hidden = true;
  }
});

document.addEventListener("fullscreenchange", () => {
  fullscreenGame.textContent = document.fullscreenElement ? "Exit full screen" : "Full screen";
});

document.body.classList.toggle(
  "touch-controls",
  window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0,
);

for (const button of accessibleControls.querySelectorAll<HTMLButtonElement>("[data-game-control]")) {
  const control = button.dataset.gameControl as PlatformerControl;
  const activePointers = new Set<number>();
  let keyboardActive = false;
  let keyboardTimer: number | undefined;
  let applied = false;
  const sync = (): void => {
    const pressed = activePointers.size > 0 || keyboardActive;
    button.setAttribute("aria-pressed", String(pressed));
    button.classList.toggle("pressed", pressed);
    if (pressed === applied) return;
    applied = pressed;
    playerModule?.setPlatformerControl(game, control, pressed);
  };
  const releasePointer = (event: PointerEvent): void => {
    if (!activePointers.delete(event.pointerId)) return;
    sync();
  };
  const releaseAll = (): void => {
    window.clearTimeout(keyboardTimer);
    keyboardTimer = undefined;
    keyboardActive = false;
    activePointers.clear();
    sync();
  };
  const activateKeyboard = (): void => {
    window.clearTimeout(keyboardTimer);
    keyboardActive = true;
    sync();
    keyboardTimer = window.setTimeout(() => {
      keyboardActive = false;
      keyboardTimer = undefined;
      sync();
    }, control === "jump" || control === "action" ? 120 : 300);
  };
  const activateFocusedSpace = (event: KeyboardEvent): void => {
    if (event.key !== " " || event.repeat || document.activeElement !== button) return;
    // Phaser captures Space above the button target. Handle it first at the
    // window boundary so a focused switch/keyboard control remains operable.
    event.preventDefault();
    event.stopImmediatePropagation();
    activateKeyboard();
  };
  window.addEventListener("keydown", activateFocusedSpace, { capture: true });
  button.setAttribute("aria-pressed", "false");
  button.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    activePointers.add(event.pointerId);
    try { button.setPointerCapture(event.pointerId); } catch { /* global release remains active */ }
    sync();
  });
  button.addEventListener("pointerup", releasePointer);
  button.addEventListener("pointercancel", releasePointer);
  button.addEventListener("lostpointercapture", releasePointer);
  window.addEventListener("pointerup", releasePointer);
  window.addEventListener("pointercancel", releasePointer);
  button.addEventListener("click", (event) => {
    // Pointer input was already handled by pointerdown/up. Browsers synthesize
    // a click after pointerup; replaying it would keep moving after release.
    // A detail of zero identifies keyboard/assistive activation.
    if (event.detail !== 0) return;
    activateKeyboard();
  });
  gameControlReleases.push(releaseAll);
}
window.addEventListener("blur", releaseAllGameControls);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") releaseAllGameControls();
});
saveGame.disabled = currentSpec === null || currentSpec === undefined;
if (currentSpec === null || currentSpec === undefined) showGameWaiting();
else play(currentSpec);
