import {
  emptyInputFrame,
  type InputFrame,
} from "../../../packages/runtime/src/input-frame.js";

export type ReplayPolicyId = "baseline" | "idle" | "delayed_noisy" | "recovery";

function copyAt(input: InputFrame, frame: number): InputFrame {
  return { ...input, frame };
}

/** Deterministic policy variants used by both local and fleet browser replay. */
export function applyReplayPolicy(
  inputFrames: readonly InputFrame[],
  policy: ReplayPolicyId,
): InputFrame[] {
  if (policy === "baseline") return inputFrames.map((input) => ({ ...input }));
  if (policy === "idle") return inputFrames.map((input) => emptyInputFrame(input.frame));

  const prefixFrames = policy === "recovery" ? 45 : 12;
  const prefix = Array.from({ length: prefixFrames }, (_, index) => {
    const input = emptyInputFrame(index + 1);
    if (policy === "recovery") input.left = true;
    return input;
  });
  const shifted = inputFrames.map((input, index) => {
    const frame = prefixFrames + index + 1;
    // A short, deterministic missed-input cadence approximates young-player
    // timing noise without using wall-clock or random sampling.
    if (policy === "delayed_noisy" && frame % 17 === 0) return emptyInputFrame(frame);
    return copyAt(input, frame);
  });
  const recoveryRetry = [
    ...Array.from({ length: 30 }, (_, index) => (
      emptyInputFrame(prefix.length + shifted.length + index + 1)
    )),
    ...inputFrames.map((input, index) => (
      copyAt(input, prefix.length + shifted.length + 30 + index + 1)
    )),
  ];
  const lastDirectional = [...inputFrames].reverse().find((input) => (
    input.left || input.right || input.jump || input.down
  ));
  const tail = Array.from({ length: 90 }, (_, index) => {
    const input = emptyInputFrame(prefix.length + shifted.length + recoveryRetry.length + index + 1);
    if (lastDirectional) {
      input.left = lastDirectional.left;
      input.right = lastDirectional.right;
      input.jump = lastDirectional.jump;
      input.down = lastDirectional.down;
    }
    return input;
  });
  return [...prefix, ...shifted, ...recoveryRetry, ...tail];
}
