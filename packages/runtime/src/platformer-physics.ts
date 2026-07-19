/** Shared by the Phaser player and the deterministic Lane A solver. */
export const PLATFORMER_PHYSICS = {
  gravityY: 1_050,
  fixedStepSeconds: 1 / 60,
  maxVelocityX: 250,
  maxVelocityY: 700,
  moveVelocityX: 220,
  projectileVelocity: 520,
  projectileCooldownMs: 360,
  // Long enough to cross the full 960x540 world diagonal. A one-tap,
  // auto-aimed action must not fail only because the drawn target is far away.
  projectileLifetimeMs: 2_500,
  // Free-movement drawings can have broad paper crops. Collision follows the
  // central body, not the entire visual bounding box.
  freeMovementColliderScale: 0.58,
  jumpVelocityY: -600,
  launchpadVelocityY: -760,
  cloudJumpVelocityY: -570,
  iceAccelerationPerFrame: 18,
  iceCoastRetention: 0.982,
  waterGravityY: 260,
  waterMoveVelocityX: 180,
  waterJumpVelocityY: -360,
  maxJumps: 2,
  coyoteTimeMs: 150,
  jumpBufferMs: 180,
  // A child who touches a hazard must have enough time to move clear of a
  // dense hand-drawn cluster before it can cost another life. This duration
  // is shared by Phaser and P8 so repeated overlap cannot consume all lives.
  invulnerabilityMs: 3_500,
  surviveDurationMs: 15_000,
  stuckCueAfterMs: 6_000,
  assistOfferAfterMs: 10_000,
  assistDurationMs: 8_000,
  progressDistance: 24,
  maxPlaytestSeconds: 30,
} as const;

/** Shared collision contract: every drawn platform is a landing surface. */
export const ONE_WAY_PLATFORM_COLLISION = {
  up: true,
  down: false,
  left: false,
  right: false,
} as const;
