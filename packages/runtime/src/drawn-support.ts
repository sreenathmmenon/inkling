/**
 * Single source of truth for the drawn-support faithfulness rule.
 *
 * A faithful ground/auto_ground game runs on the child's drawn surfaces: a
 * route that only ever stands on the synthetic Lane A safety floor is not the
 * drawn game faithfully executed. Exactly two consumers apply this rule and
 * both must call these helpers so the server's PlayContract decision and the
 * client's runtime-trace audit can never drift:
 *
 * - `createPlayContract` (server): checks the deterministic solver route's
 *   landed-surface evidence before claiming `faithful_ready`.
 * - `validateRuntimeTrace` (client audit): checks the real scene's
 *   `surface_landed` events (`faithful_route_used_no_drawn_support`).
 */

/** The synthetic always-present Lane A floor; never drawn support. */
export const SAFETY_FLOOR_ENTITY_ID = "lane_a_safety_floor";

export function isDrawnSupportSurfaceId(entityId: string): boolean {
  return entityId !== SAFETY_FLOOR_ENTITY_ID;
}

/**
 * True when a route with the given effective movement is allowed to claim
 * drawn support. Movements without a ground route trivially satisfy the rule;
 * ground/auto_ground routes must have landed on at least one non-safety-floor
 * surface.
 */
export function groundRouteUsedDrawnSupport(
  effectiveMovement: string,
  landedSurfaceIds: readonly string[],
): boolean {
  if (effectiveMovement !== "ground" && effectiveMovement !== "auto_ground") return true;
  return landedSurfaceIds.some(isDrawnSupportSurfaceId);
}
