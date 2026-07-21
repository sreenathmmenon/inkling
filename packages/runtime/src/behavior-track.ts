/**
 * Certified behavior motion tracks — the bridge that lets a child's drawn
 * entity actually move without model-written code ever executing in the
 * browser. The Lane B sandbox runs a validated behavior module for the full
 * solver horizon at generation time and records the motion it produced as
 * bounded, quantized data. The deterministic runtime, the analytic
 * playtester, and the real-browser replay all consume the identical track,
 * so solver agreement and replay determinism hold by construction, and the
 * sandbox stays the only place generated code has ever run.
 */

export const BEHAVIOR_TRACK_FORMAT = "inkling-behavior-track-v1";

/** Fixed simulation step shared with the platformer and the playtester. */
export const TRACK_DT = 1 / 60;

/** Full solver horizon: 30 simulated seconds at 60fps. */
export const MAX_TRACK_FRAMES = 1800;

/** Offsets are clamped to half the world so a track can never leave play. */
export const MAX_TRACK_OFFSET_X = 480;
export const MAX_TRACK_OFFSET_Y = 270;

/**
 * Certified motion must be motion a child can actually see. The smallest
 * supported viewport (320px wide) renders the 960px world at 1/3 scale, so
 * 12 world px is ~4 device px of travel there — above the screen-motion
 * perception floor and larger than a typical hazard's collision slack.
 * Sub-threshold tracks are static claims wearing a dynamic label, which is
 * exactly the false-faithful the capability evidence must never accept.
 */
export const MIN_TRACK_PEAK_OFFSET = 12;

export function trackPeakOffset(offsets: ReadonlyArray<readonly [number, number]>): number {
  let peak = 0;
  for (const [x, y] of offsets) {
    peak = Math.max(peak, Math.abs(x), Math.abs(y));
  }
  return peak;
}

/**
 * Only roles whose motion Lane A can execute safely carry tracks: things
 * that hurt on contact and never carry the hero. Surfaces are excluded so a
 * track can never move the ground out from under a standing player.
 */
export const TRACK_ANIMATABLE_ROLES: ReadonlySet<string> = new Set([
  "enemy",
  "boss",
  "hazard",
]);

export interface BehaviorMotionTrack {
  format: typeof BEHAVIOR_TRACK_FORMAT;
  entityId: string;
  dt: number;
  /** Per-frame [x, y] displacement from the entity's planned position, px. */
  offsets: Array<[number, number]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isBehaviorMotionTrack(value: unknown): value is BehaviorMotionTrack {
  if (!isRecord(value) || value.format !== BEHAVIOR_TRACK_FORMAT) return false;
  if (typeof value.entityId !== "string" || value.entityId.length === 0) return false;
  if (value.dt !== TRACK_DT) return false;
  if (!Array.isArray(value.offsets) || value.offsets.length === 0) return false;
  if (value.offsets.length > MAX_TRACK_FRAMES) return false;
  const wellFormed = value.offsets.every((offset) =>
    Array.isArray(offset) &&
    offset.length === 2 &&
    typeof offset[0] === "number" &&
    typeof offset[1] === "number" &&
    Number.isFinite(offset[0]) &&
    Number.isFinite(offset[1]) &&
    Math.abs(offset[0]) <= MAX_TRACK_OFFSET_X &&
    Math.abs(offset[1]) <= MAX_TRACK_OFFSET_Y,
  );
  if (!wellFormed) return false;
  return trackPeakOffset(value.offsets as Array<[number, number]>) >= MIN_TRACK_PEAK_OFFSET;
}

/** Tracks loop after their recorded horizon so motion never freezes. */
export function trackOffsetAt(
  track: BehaviorMotionTrack,
  frame: number,
): readonly [number, number] {
  const index = ((Math.floor(frame) % track.offsets.length) + track.offsets.length) % track.offsets.length;
  return track.offsets[index] ?? [0, 0];
}

/**
 * Parses an untrusted map of entity-id → track (e.g. from a saved playable
 * document), keeping only tracks that validate and whose id matches the key.
 */
export function parseBehaviorTracks(
  value: unknown,
): Record<string, BehaviorMotionTrack> {
  const tracks: Record<string, BehaviorMotionTrack> = {};
  if (!isRecord(value)) return tracks;
  for (const [entityId, candidate] of Object.entries(value)) {
    if (isBehaviorMotionTrack(candidate) && candidate.entityId === entityId) {
      tracks[entityId] = candidate;
    }
  }
  return tracks;
}
