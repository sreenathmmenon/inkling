/** Reserved for deterministic entities created by the trusted Lane A recast. */
export const P8_SYNTHETIC_ENTITY_PREFIX = "__inkling_p8_synthetic__";

export function isP8SyntheticEntityId(id: string): boolean {
  return id.startsWith(P8_SYNTHETIC_ENTITY_PREFIX);
}
