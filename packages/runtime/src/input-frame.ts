export interface InputFrame {
  format: "inkling-input-frame-v1";
  frame: number;
  left: boolean;
  right: boolean;
  jump: boolean;
  down: boolean;
  action: boolean;
  assist: boolean;
}

export function emptyInputFrame(frame: number): InputFrame {
  return {
    format: "inkling-input-frame-v1",
    frame,
    left: false,
    right: false,
    jump: false,
    down: false,
    action: false,
    assist: false,
  };
}
