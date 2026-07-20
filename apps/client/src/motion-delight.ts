import type { PlatformerState } from "../../../packages/runtime/src/platformer.js";
import type { RuntimeEvent } from "../../../packages/runtime/src/runtime-events.js";

type MotionTarget = "shell" | "status" | "controls" | "actions";

interface MotionCue {
  target: MotionTarget;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
}

interface MotionDelightOptions {
  shell: HTMLElement;
  status: HTMLElement;
  controls: HTMLElement;
  actions: HTMLElement;
  reducedMotion?: () => boolean;
}

export interface MotionDelightController {
  gameRevealed(): void;
  generationStageChanged(element: HTMLElement): void;
  handleRuntimeEvent(event: RuntimeEvent): void;
  stateChanged(status: PlatformerState["status"]): void;
}

const QUICK_EASE = "cubic-bezier(.2,.8,.2,1)";

export function runtimeMotionCue(kind: RuntimeEvent["kind"]): MotionCue | null {
  switch (kind) {
    case "pickup":
    case "unlock":
      return {
        target: "status",
        keyframes: [
          { filter: "brightness(1)", boxShadow: "0 8px 22px rgba(32,25,54,.2)" },
          { filter: "brightness(1.3)", boxShadow: "0 0 0 5px rgba(255,213,86,.32)" },
          { filter: "brightness(1)", boxShadow: "0 8px 22px rgba(32,25,54,.2)" },
        ],
        options: { duration: 360, easing: QUICK_EASE },
      };
    case "damage":
      return {
        target: "shell",
        keyframes: [
          { transform: "translateX(0)" },
          { transform: "translateX(-5px)" },
          { transform: "translateX(5px)" },
          { transform: "translateX(0)" },
        ],
        options: { duration: 220, easing: "ease-out" },
      };
    case "assist_available":
    case "assist_activated":
      return {
        target: "controls",
        keyframes: [
          { filter: "brightness(1)" },
          { filter: "brightness(1.22)" },
          { filter: "brightness(1)" },
        ],
        options: { duration: 480, easing: QUICK_EASE },
      };
    case "goal_blocked":
    case "stuck_cue":
      return {
        target: "status",
        keyframes: [{ opacity: 1 }, { opacity: 0.68 }, { opacity: 1 }],
        options: { duration: 360, easing: "ease-in-out" },
      };
    default:
      return null;
  }
}

export function attachMotionDelight(options: MotionDelightOptions): MotionDelightController {
  const reducedMotion = options.reducedMotion ?? (
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  const targets: Record<MotionTarget, HTMLElement> = {
    shell: options.shell,
    status: options.status,
    controls: options.controls,
    actions: options.actions,
  };
  const running = new Map<HTMLElement, Animation>();

  const animate = (
    target: HTMLElement,
    keyframes: Keyframe[],
    timing: KeyframeAnimationOptions,
  ): void => {
    if (reducedMotion() || typeof target.animate !== "function") return;
    try {
      running.get(target)?.cancel();
      const animation = target.animate(keyframes, timing);
      running.set(target, animation);
      animation.addEventListener("finish", () => {
        if (running.get(target) === animation) running.delete(target);
      }, { once: true });
    } catch {
      // Motion is a progressive enhancement and never blocks interaction.
    }
  };

  return {
    gameRevealed(): void {
      animate(options.shell, [
        { opacity: 0.45, transform: "scale(.99)" },
        { opacity: 1, transform: "scale(1)" },
      ], { duration: 440, easing: QUICK_EASE, fill: "both" });
    },
    generationStageChanged(element): void {
      animate(element, [
        { opacity: 0.7, transform: "translateX(0) scale(.985)" },
        { opacity: 1, transform: "translateX(-6px) scale(1)" },
      ], { duration: 320, easing: QUICK_EASE });
    },
    handleRuntimeEvent(event): void {
      const cue = runtimeMotionCue(event.kind);
      if (cue) animate(targets[cue.target], cue.keyframes, cue.options);
    },
    stateChanged(state): void {
      if (state === "won") {
        animate(options.shell, [
          { filter: "brightness(1) saturate(1)" },
          { filter: "brightness(1.08) saturate(1.18)" },
          { filter: "brightness(1) saturate(1)" },
        ], { duration: 820, easing: QUICK_EASE });
        animate(options.actions, [
          { opacity: 0, transform: "translateY(8px)" },
          { opacity: 1, transform: "translateY(0)" },
        ], { duration: 380, delay: 100, easing: QUICK_EASE, fill: "both" });
      } else if (state === "lost") {
        animate(options.actions, [
          { opacity: 0.35 },
          { opacity: 1 },
        ], { duration: 300, easing: "ease-out" });
      }
    },
  };
}
