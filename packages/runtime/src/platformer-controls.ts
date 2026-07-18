import { WORLD_HEIGHT, WORLD_WIDTH } from "./platformer-layout.js";

export interface TouchControlLayout {
  size: number;
  cornerRadius: number;
  y: number;
  left: [number, number];
  right: [number, number, number];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

/**
 * Keeps touch controls close to a 52 CSS-pixel target at every fitted canvas
 * size. Gameplay remains in the fixed deterministic world; only the control
 * chrome compensates for browser scaling.
 */
export function createTouchControlLayout(
  displayWidth: number,
  displayHeight: number,
): TouchControlLayout {
  const scale = Math.max(
    0.1,
    Math.min(displayWidth / WORLD_WIDTH, displayHeight / WORLD_HEIGHT),
  );
  const size = clamp(52 / scale, 44, 132);
  const gap = clamp(12 / scale, 10, 28);
  const margin = clamp(12 / scale, 8, 32);
  const leftFirst = margin + size / 2;
  const leftSecond = leftFirst + size + gap;
  const rightFirst = WORLD_WIDTH - margin - size / 2;
  const rightSecond = rightFirst - size - gap;
  const rightThird = rightSecond - size - gap;
  return {
    size,
    cornerRadius: Math.min(22 / scale, size * 0.32),
    y: WORLD_HEIGHT - margin - size / 2,
    left: [leftFirst, leftSecond],
    right: [rightFirst, rightSecond, rightThird],
  };
}
