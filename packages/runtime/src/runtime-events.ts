import type { GameplayFeedbackEvent } from "./feedback-contract.js";
import type { PlatformerState } from "./platformer.js";
import type { PlayContract } from "./play-contract.js";

export type RuntimeEventKind = GameplayFeedbackEvent["kind"] |
  "state_changed" |
  "surface_landed" |
  "maze_wall_contact" |
  "material_effect" |
  "water_entered";

/**
 * Small, deterministic evidence records emitted by the real Phaser scene.
 * Frame and sequence—not wall-clock time—are the replay identity.
 */
export interface RuntimeEvent {
  format: "inkling-runtime-event-v1";
  sequence: number;
  frame: number;
  kind: RuntimeEventKind;
  entityId: string | null;
  required: boolean;
  state: PlatformerState;
}

export interface RuntimeTraceReport {
  format: "inkling-runtime-trace-report-v1";
  contractFormat: PlayContract["format"];
  templateId: PlayContract["templateId"];
  runtimeVersion: PlayContract["runtimeVersion"];
  valid: boolean;
  blockers: string[];
  inputAccepted: boolean;
  reachedTerminalState: boolean;
  finalStatus: PlatformerState["status"] | null;
  finalFrame: number | null;
}
