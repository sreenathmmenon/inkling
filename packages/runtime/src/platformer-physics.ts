/** Shared by the Phaser player and the deterministic Lane A solver. */
export const PLATFORMER_PHYSICS = {
  gravityY: 1_050,
  fixedStepSeconds: 1 / 60,
  maxVelocityX: 250,
  maxVelocityY: 700,
  moveVelocityX: 220,
  projectileVelocity: 520,
  projectileCooldownMs: 360,
  // Free-movement drawings can have broad paper crops. Collision follows the
  // central body, not the entire visual bounding box.
  freeMovementColliderScale: 0.58,
  jumpVelocityY: -600,
  maxJumps: 2,
  coyoteTimeMs: 150,
  jumpBufferMs: 180,
  // A child who touches a hazard must have enough time to move clear of a
  // dense hand-drawn cluster before it can cost another life. This duration
  // is shared by Phaser and P8 so repeated overlap cannot consume all lives.
  invulnerabilityMs: 3_500,
  surviveDurationMs: 15_000,
  maxPlaytestSeconds: 30,
} as const;

/** Shared collision contract: every drawn platform is a landing surface. */
export const ONE_WAY_PLATFORM_COLLISION = {
  up: true,
  down: false,
  left: false,
  right: false,
} as const;
