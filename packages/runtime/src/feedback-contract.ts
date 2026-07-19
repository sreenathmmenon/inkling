export type GameplayFeedbackKind =
  | "input_accepted"
  | "pickup"
  | "unlock"
  | "stuck_cue"
  | "assist_available"
  | "assist_activated"
  | "damage"
  | "goal_blocked"
  | "projectile"
  | "win"
  | "lose";

export interface GameplayFeedbackEvent {
  kind: GameplayFeedbackKind;
  elapsedMs: number;
  entityId: string | null;
  required: boolean;
}

export interface GameplayFeedbackCue {
  label: string | null;
  color: number;
  durationMs: number;
  motion: "none" | "pop" | "rise" | "celebrate";
}

/**
 * Presentation metadata for deterministic Lane A feedback. It depends only on
 * gameplay semantics, never on a drawing name, filename, or recognized noun.
 */
export function feedbackCueFor(
  event: GameplayFeedbackEvent,
  reducedMotion: boolean,
): GameplayFeedbackCue {
  const motion = <T extends GameplayFeedbackCue["motion"]>(value: T): T | "none" => (
    reducedMotion ? "none" : value
  );
  switch (event.kind) {
    case "input_accepted":
      return { label: null, color: 0xffffff, durationMs: 0, motion: "none" };
    case "pickup":
      return {
        label: event.required ? "Found!" : "Bonus!",
        color: 0xffd556,
        durationMs: 700,
        motion: motion("rise"),
      };
    case "unlock":
      return { label: "Unlocked!", color: 0x8fe8ff, durationMs: 820, motion: motion("pop") };
    case "stuck_cue":
      return { label: "Try the glowing direction", color: 0xffd556, durationMs: 1_300, motion: motion("pop") };
    case "assist_available":
      return { label: "Help is ready", color: 0x8fe8ff, durationMs: 1_000, motion: motion("pop") };
    case "assist_activated":
      return { label: "Extra jump + speed", color: 0x8fe8ff, durationMs: 1_000, motion: motion("rise") };
    case "damage":
      return { label: "Life lost", color: 0xff6b78, durationMs: 760, motion: motion("pop") };
    case "goal_blocked":
      return { label: "Find everything first", color: 0xffd556, durationMs: 900, motion: motion("pop") };
    case "projectile":
      return { label: "Go!", color: 0x8fe8ff, durationMs: 420, motion: motion("rise") };
    case "win":
      return { label: "You did it!", color: 0xffd556, durationMs: 1_600, motion: motion("celebrate") };
    case "lose":
      return { label: "Try again", color: 0xffc4cf, durationMs: 1_000, motion: motion("pop") };
  }
}

/** Fixed normalized points keep celebration repeatable for a seed/input trace. */
export const CELEBRATION_POINTS: ReadonlyArray<readonly [number, number]> = [
  [-0.38, -0.2], [-0.25, -0.34], [-0.1, -0.27], [0.08, -0.36],
  [0.25, -0.26], [0.39, -0.13], [-0.34, 0.02], [-0.18, 0.13],
  [0.02, 0.08], [0.2, 0.15], [0.36, 0.04], [0, -0.16],
];
