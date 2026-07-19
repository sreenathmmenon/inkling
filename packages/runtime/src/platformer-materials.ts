import { PLATFORMER_PHYSICS } from "./platformer-physics.js";

export type SurfaceMaterial = "solid" | "ice" | "cloud" | "launchpad" | "mover";

export function surfaceMaterial(role: string | undefined): SurfaceMaterial {
  if (role === "ice" || role === "cloud" || role === "launchpad" || role === "mover") return role;
  return "solid";
}

/** Fixed-step horizontal motion shared by Phaser and the analytic trace search. */
export function surfaceVelocityX(
  currentVelocity: number,
  direction: -1 | 0 | 1,
  role: string | undefined,
  assistActive = false,
): number {
  const material = surfaceMaterial(role);
  const maximum = PLATFORMER_PHYSICS.moveVelocityX * (assistActive ? 1.16 : 1);
  if (material !== "ice") return direction * maximum;
  if (direction === 0) {
    const drifting = currentVelocity * PLATFORMER_PHYSICS.iceCoastRetention;
    return Math.abs(drifting) < 3 ? 0 : drifting;
  }
  const target = direction * maximum;
  const delta = Math.max(
    -PLATFORMER_PHYSICS.iceAccelerationPerFrame,
    Math.min(PLATFORMER_PHYSICS.iceAccelerationPerFrame, target - currentVelocity),
  );
  return currentVelocity + delta;
}

export function surfaceJumpVelocity(role: string | undefined, assistActive = false): number {
  const material = surfaceMaterial(role);
  const base = material === "launchpad"
    ? PLATFORMER_PHYSICS.launchpadVelocityY
    : material === "cloud"
      ? PLATFORMER_PHYSICS.cloudJumpVelocityY
      : PLATFORMER_PHYSICS.jumpVelocityY;
  return assistActive ? base * 1.12 : base;
}

