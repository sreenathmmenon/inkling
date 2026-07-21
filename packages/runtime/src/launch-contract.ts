import { PLATFORMER_PHYSICS } from "./platformer-physics.js";
import { WORLD_HEIGHT, WORLD_WIDTH } from "./world-geometry.js";

/**
 * The deterministic aim-and-launch contract for `launch` movement (slingshot).
 * This exact state machine is consumed frame-for-frame by BOTH the production
 * Phaser scene and the analytic P8 solver, so the two cannot diverge: same
 * quantized aim angles, same fixed power, same gravity, same landing rule,
 * same return-to-anchor rule. It has no wall-clock and no randomness.
 */
export const LAUNCH_CONTRACT = {
  /** Aim is quantized to fixed steps so taps are predictable and replayable. */
  minAimDeg: 15,
  maxAimDeg: 165,
  aimStepDeg: 15,
  /** Straight up: no left/right bias before the child expresses one. */
  initialAimDeg: 90,
  /**
   * Fixed launch power. Below maxVelocityY so no allowed angle clamps its
   * initial vertical speed, keeping every quantized trajectory smooth.
   */
  launchSpeed: 700,
  /** Frames the hero visibly rests where it landed before the next shot. */
  restFrames: 18,
  /** Upper bound on sequential shots the analytic solver may plan. */
  maxSolverShots: 6,
  /** Safety bound on a single simulated shot; real flights end far sooner. */
  maxFlightFrames: 300,
} as const;

export type LaunchPhase = "aiming" | "flight" | "rest";

export interface LaunchInput {
  left: boolean;
  right: boolean;
  jump: boolean;
  action: boolean;
}

export interface LaunchSurface {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LaunchWorld {
  /** Hero collision size (already collider-scaled), not the visual bounds. */
  heroWidth: number;
  heroHeight: number;
  /** One-way landing surfaces, including the Lane A safety floor. */
  platforms: readonly LaunchSurface[];
}

export interface LaunchState {
  phase: LaunchPhase;
  aimDeg: number;
  anchorX: number;
  anchorY: number;
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  restFramesRemaining: number;
  shotsFired: number;
  /**
   * Previous-frame input while aiming; taps are edge-triggered so a held
   * button is one aim step, not a sweep. Flight/rest frames do not advance
   * these, so a press spanning a phase boundary still lands as one tap.
   */
  prevLeft: boolean;
  prevRight: boolean;
  prevFire: boolean;
}

export interface LaunchStepResult {
  fired: boolean;
  landed: boolean;
  returnedToAnchor: boolean;
}

export function createLaunchState(anchorX: number, anchorY: number): LaunchState {
  return {
    phase: "aiming",
    aimDeg: LAUNCH_CONTRACT.initialAimDeg,
    anchorX,
    anchorY,
    x: anchorX,
    y: anchorY,
    velocityX: 0,
    velocityY: 0,
    restFramesRemaining: 0,
    shotsFired: 0,
    prevLeft: false,
    prevRight: false,
    prevFire: false,
  };
}

/** Angle is degrees from the +x axis; up is positive, so 90 aims straight up. */
export function launchVelocityForAim(aimDeg: number): [number, number] {
  const radians = (aimDeg * Math.PI) / 180;
  return [
    Math.cos(radians) * LAUNCH_CONTRACT.launchSpeed,
    -Math.sin(radians) * LAUNCH_CONTRACT.launchSpeed,
  ];
}

/** Returns the hero to the anchor for the next shot; the child keeps their aim. */
export function resetLaunchShot(state: LaunchState): void {
  state.phase = "aiming";
  state.x = state.anchorX;
  state.y = state.anchorY;
  state.velocityX = 0;
  state.velocityY = 0;
  state.restFramesRemaining = 0;
  state.prevLeft = false;
  state.prevRight = false;
  state.prevFire = false;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

/**
 * Advances the launch state by exactly one fixed 60 fps step. Aiming reacts
 * to edge-triggered taps; flight is deterministic ballistics under the shared
 * gravity constant; landing on a drawn surface (or the safety floor) comes to
 * rest briefly, then the hero returns to the anchor for the next shot.
 */
export function stepLaunchFrame(
  state: LaunchState,
  input: LaunchInput,
  world: LaunchWorld,
): LaunchStepResult {
  const result: LaunchStepResult = { fired: false, landed: false, returnedToAnchor: false };
  if (state.phase === "aiming") {
    const leftTap = input.left && !state.prevLeft;
    const rightTap = input.right && !state.prevRight;
    const fireDown = input.jump || input.action;
    const fireTap = fireDown && !state.prevFire;
    state.prevLeft = input.left;
    state.prevRight = input.right;
    state.prevFire = fireDown;
    if (leftTap !== rightTap) {
      state.aimDeg = clamp(
        state.aimDeg + (leftTap ? LAUNCH_CONTRACT.aimStepDeg : -LAUNCH_CONTRACT.aimStepDeg),
        LAUNCH_CONTRACT.minAimDeg,
        LAUNCH_CONTRACT.maxAimDeg,
      );
    }
    if (fireTap) {
      const [velocityX, velocityY] = launchVelocityForAim(state.aimDeg);
      state.velocityX = velocityX;
      state.velocityY = velocityY;
      state.phase = "flight";
      state.shotsFired += 1;
      result.fired = true;
    }
    return result;
  }
  if (state.phase === "rest") {
    state.restFramesRemaining -= 1;
    if (state.restFramesRemaining <= 0) {
      resetLaunchShot(state);
      result.returnedToAnchor = true;
    }
    return result;
  }

  const dt = PLATFORMER_PHYSICS.fixedStepSeconds;
  state.velocityY = Math.min(
    state.velocityY + PLATFORMER_PHYSICS.gravityY * dt,
    PLATFORMER_PHYSICS.maxVelocityY,
  );
  const previousBottom = state.y + world.heroHeight / 2;
  state.x += state.velocityX * dt;
  state.y += state.velocityY * dt;
  const minX = world.heroWidth / 2;
  const maxX = WORLD_WIDTH - world.heroWidth / 2;
  if (state.x <= minX) {
    state.x = minX;
    state.velocityX = Math.max(0, state.velocityX);
  } else if (state.x >= maxX) {
    state.x = maxX;
    state.velocityX = Math.min(0, state.velocityX);
  }
  if (state.y - world.heroHeight / 2 < 0) {
    state.y = world.heroHeight / 2;
    state.velocityY = Math.max(0, state.velocityY);
  }
  if (state.velocityY >= 0) {
    const currentBottom = state.y + world.heroHeight / 2;
    const landing = world.platforms
      .filter((platform) => {
        const top = platform.y - platform.height / 2;
        return (
          Math.abs(state.x - platform.x) * 2 < world.heroWidth + platform.width &&
          previousBottom <= top + 2 &&
          currentBottom >= top
        );
      })
      .sort((left, right) => (left.y - left.height / 2) - (right.y - right.height / 2))[0];
    if (landing) {
      state.y = landing.y - landing.height / 2 - world.heroHeight / 2 - 2;
      state.velocityX = 0;
      state.velocityY = 0;
      state.phase = "rest";
      state.restFramesRemaining = LAUNCH_CONTRACT.restFrames;
      result.landed = true;
      return result;
    }
  }
  if (state.y - world.heroHeight / 2 > WORLD_HEIGHT) {
    resetLaunchShot(state);
    result.returnedToAnchor = true;
  }
  return result;
}
