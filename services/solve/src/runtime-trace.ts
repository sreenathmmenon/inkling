import type { PlayContract } from "../../../packages/runtime/src/play-contract.js";
import type { RuntimeEvent } from "../../../packages/runtime/src/runtime-events.js";
import type { RuntimeTraceReport } from "../../../packages/runtime/src/runtime-events.js";
export type { RuntimeTraceReport } from "../../../packages/runtime/src/runtime-events.js";

/**
 * Validates evidence emitted by the real Phaser scene. It deliberately does
 * not infer success from elapsed time or geometry: the scene must emit a
 * legal, input-backed transition to a terminal state.
 */
export function validateRuntimeTrace(
  events: readonly RuntimeEvent[],
  playContract: PlayContract,
): RuntimeTraceReport {
  const blockers: string[] = [];
  let previousFrame = -1;
  let previousLives: number | undefined;
  let terminalSeen = false;
  let inputAccepted = false;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.format !== "inkling-runtime-event-v1") blockers.push("invalid_event_format");
    if (event.sequence !== index) blockers.push("non_contiguous_event_sequence");
    if (!Number.isInteger(event.frame) || event.frame < previousFrame) {
      blockers.push("non_monotonic_frame_sequence");
    }
    previousFrame = event.frame;
    if (event.kind === "input_accepted") inputAccepted = true;

    if (previousLives !== undefined) {
      if (event.state.lives > previousLives) blockers.push("lives_increased_without_restart");
      if (previousLives - event.state.lives > 1) blockers.push("multiple_lives_lost_in_one_transition");
    }
    previousLives = event.state.lives;

    if (terminalSeen && event.state.status === "playing") {
      blockers.push("terminal_state_returned_to_playing");
    }
    if (event.state.status === "won" || event.state.status === "lost") terminalSeen = true;

    if (event.kind === "win") {
      if (event.state.status !== "won") blockers.push("win_event_without_won_state");
      if (playContract.goalKind !== "survive" && !inputAccepted) {
        blockers.push("idle_win_without_accepted_input");
      }
      if (
        playContract.goalKind === "collect_all" &&
        event.state.collected < event.state.collectibleTotal
      ) {
        blockers.push("collect_all_won_before_all_items_collected");
      }
      if (
        playContract.requiredCapabilities.includes("aimed_projectile") &&
        !events.slice(0, index).some((candidate) => candidate.kind === "projectile")
      ) {
        blockers.push("projectile_goal_won_without_projectile");
      }
    }
  }

  const final = events.at(-1);
  if (!final) blockers.push("runtime_trace_is_empty");
  if (!terminalSeen) blockers.push("runtime_trace_has_no_terminal_state");
  if (playContract.outcome !== "faithful_ready") blockers.push("play_contract_is_not_faithful_ready");
  if (
    playContract.requiredCapabilities.includes("key_door_unlock") &&
    !events.some((event) => event.kind === "unlock")
  ) {
    blockers.push("key_door_goal_completed_without_unlock_event");
  }
  const winIndex = events.findIndex((event) => event.kind === "win");
  const eventsBeforeWin = winIndex >= 0 ? events.slice(0, winIndex) : events;
  if (
    playContract.requiredCapabilities.includes("launch_trajectory") &&
    playContract.goalKind !== "survive" &&
    winIndex >= 0 &&
    !eventsBeforeWin.some((event) => event.kind === "launch_fired")
  ) {
    // A slingshot win must come from an actually fired shot, not from
    // geometry that happened to overlap the anchored hero.
    blockers.push("launch_win_without_fired_shot");
  }
  for (const entityId of playContract.requiredInteractionEntityIds ?? []) {
    if (!eventsBeforeWin.some((event) => (
      event.kind === "pickup" && event.required && event.entityId === entityId
    ))) {
      blockers.push(`required_interaction_missing:${entityId}`);
    }
  }
  if (
    (playContract.effectiveMovement === "ground" || playContract.effectiveMovement === "auto_ground") &&
    terminalSeen &&
    !events.some((event) => event.kind === "surface_landed" && event.entityId !== "lane_a_safety_floor")
  ) {
    blockers.push("faithful_route_used_no_drawn_support");
  }

  return {
    format: "inkling-runtime-trace-report-v1",
    contractFormat: playContract.format,
    templateId: playContract.templateId,
    runtimeVersion: playContract.runtimeVersion,
    valid: blockers.length === 0,
    blockers: [...new Set(blockers)],
    inputAccepted,
    reachedTerminalState: terminalSeen,
    finalStatus: final?.state.status ?? null,
    finalFrame: final?.frame ?? null,
  };
}
