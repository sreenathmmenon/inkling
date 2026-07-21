/**
 * The deterministic Lane A grammar. These are engine contracts for the
 * authoritative GameSpec genre enum—not recognizers for particular drawings.
 * The model decides the genre and entities; this table decides only how that
 * declared world is controlled and simulated.
 */
export type DeclaredGenre =
  | "platformer"
  | "maze"
  | "runner"
  | "slingshot";

export type MovementContract = "ground" | "free" | "auto_ground" | "launch";
export type ActionContract = "contact" | "projectile";

export interface GameContract {
  id: DeclaredGenre;
  movement: MovementContract;
  /** Art is always visible; only the collision body changes by contract. */
  colliderScale: number;
  touchControls: "side" | "four_way";
  action: ActionContract;
  instruction: string;
}

export const GAME_CONTRACTS: Record<DeclaredGenre, GameContract> = {
  platformer: {
    id: "platformer", movement: "ground", colliderScale: 1, touchControls: "side", action: "contact",
    instruction: "Run, jump, and reach your goal",
  },
  maze: {
    id: "maze", movement: "free", colliderScale: 0.72, touchControls: "four_way", action: "contact",
    instruction: "Find a path through your world",
  },
  runner: {
    id: "runner", movement: "auto_ground", colliderScale: 0.9, touchControls: "side", action: "contact",
    instruction: "Keep running and jump over danger",
  },
  slingshot: {
    id: "slingshot", movement: "launch", colliderScale: 0.68, touchControls: "four_way", action: "projectile",
    instruction: "Aim, launch, and reach your target",
  },
};

export function contractForGenre(value: unknown): GameContract {
  return typeof value === "string" && value in GAME_CONTRACTS
    ? GAME_CONTRACTS[value as DeclaredGenre]
    : GAME_CONTRACTS.platformer;
}
