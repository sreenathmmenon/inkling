export const INKLING_FONT_FAMILY = "Nunito Variable, Nunito, system-ui, sans-serif";

/** Product-owned cue colors. They label mechanics and never recolor source art. */
export const INKLING_CUE = Object.freeze({
  ink: 0x292343,
  paper: 0xfffbf4,
  violet: 0x6f5be7,
  violetDeep: 0x4f3fc2,
  sky: 0x75d7e8,
  coral: 0xef6f7b,
  sun: 0xffd866,
  mint: 0x79c9ad,
});

export interface BoundedCueAnchor {
  x: number;
  y: number;
  originY: 0 | 1;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

/** Keeps lightweight labels inside the visible world without moving gameplay. */
export function boundedCueAnchor(
  x: number,
  top: number,
  bottom: number,
  viewportWidth: number,
  viewportHeight: number,
  halfWidth = 42,
  margin = 14,
): BoundedCueAnchor {
  const canSitAbove = top >= 42;
  return {
    x: clamp(x, margin + halfWidth, viewportWidth - margin - halfWidth),
    y: canSitAbove
      ? clamp(top - 10, margin, viewportHeight - margin)
      : clamp(bottom + 10, margin, viewportHeight - margin),
    originY: canSitAbove ? 1 : 0,
  };
}

/** A bounded substrate-aware backplate improves faint-mark legibility only. */
export function artworkHaloForWorldColor(worldColor: number): { color: number; alpha: number } {
  const red = (worldColor >> 16) & 0xff;
  const green = (worldColor >> 8) & 0xff;
  const blue = worldColor & 0xff;
  const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
  return luminance < 142
    ? { color: INKLING_CUE.paper, alpha: 0.15 }
    : { color: INKLING_CUE.violetDeep, alpha: 0.075 };
}

export function friendlyObjectiveLabel(label: string): string {
  switch (label) {
    case "FINISH": return "Goal";
    case "FIND": return "Next";
    case "CLEAR": return "Target";
    case "STAY SAFE": return "Stay safe";
    default: return label;
  }
}
