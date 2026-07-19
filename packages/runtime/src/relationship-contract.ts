import type { GameSpec } from "../../../runner/types.js";

export interface KeyDoorRelationship {
  kind: "key_opens_door";
  keyId: string;
  doorId: string;
}

/**
 * Reads only explicit GameSpec role/link data. Either side may carry the link
 * because the extraction contract describes the pair as linked without
 * assigning link direction. No names, artwork, or drawing nouns are read.
 */
export function keyDoorRelationships(gameSpec: GameSpec): KeyDoorRelationship[] {
  const byId = new Map(gameSpec.entities.map((entity) => [entity.id, entity]));
  const pairs = new Map<string, KeyDoorRelationship>();
  for (const entity of gameSpec.entities) {
    if (!entity.linked_to) continue;
    const linked = byId.get(entity.linked_to);
    if (!linked) continue;
    const key = entity.role === "key" && linked.role === "door" ? entity
      : entity.role === "door" && linked.role === "key" ? linked
      : undefined;
    const door = entity.role === "door" && linked.role === "key" ? entity
      : entity.role === "key" && linked.role === "door" ? linked
      : undefined;
    if (!key || !door) continue;
    pairs.set(`${key.id}\0${door.id}`, { kind: "key_opens_door", keyId: key.id, doorId: door.id });
  }
  return [...pairs.values()].sort((left, right) => (
    left.keyId.localeCompare(right.keyId) || left.doorId.localeCompare(right.doorId)
  ));
}

