/**
 * Landing hero demo: a real corpus drawing materializes into frames of its
 * actual generated game (captured from the live player by
 * scripts/capture-hero-demo.ts), then loops, about six seconds per cycle.
 *
 * Honesty and boot contract:
 * - Presentational only. The host is aria-hidden, contains nothing focusable,
 *   and never intercepts input from the real capture flow.
 * - Loaded lazily after first paint (dynamic import from main), so the
 *   capture shell's entry budget is untouched; game frames are fetched only
 *   when the demo first becomes visible.
 * - The drawing→game morph is the product's real materialize treatment:
 *   attachMaterialize drives --materialize/data-materialize-stage on the demo
 *   host through the real stage order — no hand-rolled crossfade timeline.
 * - prefers-reduced-motion shows an honest still pair (drawing + game frame)
 *   with no timers at all.
 * - The loop pauses whenever the demo leaves the viewport or the empty
 *   preview is replaced by the child's own drawing.
 */
import { attachMaterialize, MATERIALIZE_STAGES } from "./materialize.js";

const GAME_FRAME_SOURCES = [
  "/demo/game-0.webp",
  "/demo/game-1.webp",
  "/demo/game-2.webp",
  "/demo/game-3.webp",
] as const;

/** Cycle timing (ms): rest + 4 real stages + reveal + frames ≈ 6s. */
const REST_BEFORE_LIFT = 900;
const STAGE_INTERVAL = 550;
const REVEAL_DELAY = 350;
const FRAME_INTERVAL = 600;
const REST_AFTER_GAME = 350;

type DemoPhase = "drawing" | "game" | "still";

export function attachHeroDemo(host: HTMLElement): void {
  const drawing = host.querySelector<HTMLImageElement>(".hero-demo-drawing");
  if (!drawing) return;
  const materialize = attachMaterialize(host);
  const gameFrame = document.createElement("img");
  gameFrame.className = "hero-demo-game";
  gameFrame.alt = "";
  gameFrame.decoding = "async";
  gameFrame.width = 480;
  gameFrame.height = 270;
  host.append(gameFrame);

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let timer: number | undefined;
  let running = false;
  let framesPreloaded = false;

  const setPhase = (phase: DemoPhase): void => {
    host.setAttribute("data-demo-phase", phase);
  };

  const preloadFrames = (): void => {
    if (framesPreloaded) return;
    framesPreloaded = true;
    for (const source of GAME_FRAME_SOURCES) new Image().src = source;
  };

  const schedule = (delay: number, step: () => void): void => {
    timer = window.setTimeout(() => {
      if (running) step();
    }, delay);
  };

  const stop = (): void => {
    running = false;
    window.clearTimeout(timer);
    timer = undefined;
    materialize.reset();
  };

  const runCycle = (): void => {
    materialize.reset();
    setPhase("drawing");
    let stageIndex = 0;
    const advanceStage = (): void => {
      if (stageIndex < MATERIALIZE_STAGES.length) {
        materialize.stageReached(MATERIALIZE_STAGES[stageIndex]!);
        stageIndex += 1;
        schedule(STAGE_INTERVAL, advanceStage);
        return;
      }
      schedule(REVEAL_DELAY, () => {
        setPhase("game");
        let frame = 0;
        gameFrame.src = GAME_FRAME_SOURCES[0];
        const advanceFrame = (): void => {
          frame += 1;
          if (frame < GAME_FRAME_SOURCES.length) {
            gameFrame.src = GAME_FRAME_SOURCES[frame]!;
            schedule(FRAME_INTERVAL, advanceFrame);
            return;
          }
          schedule(REST_AFTER_GAME, runCycle);
        };
        schedule(FRAME_INTERVAL, advanceFrame);
      });
    };
    schedule(REST_BEFORE_LIFT, advanceStage);
  };

  const showStillPair = (): void => {
    stop();
    preloadFrames();
    gameFrame.src = GAME_FRAME_SOURCES[GAME_FRAME_SOURCES.length - 1]!;
    setPhase("still");
  };

  let visible = false;
  const applyMode = (): void => {
    if (!visible) {
      stop();
      if (!reducedMotion.matches) setPhase("drawing");
      return;
    }
    if (reducedMotion.matches) {
      showStillPair();
      return;
    }
    preloadFrames();
    if (running) return;
    running = true;
    setPhase("drawing");
    runCycle();
  };

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) visible = entry.isIntersecting;
    applyMode();
  }, { threshold: 0.25 });
  observer.observe(host);
  reducedMotion.addEventListener("change", () => {
    stop();
    applyMode();
  });
}
