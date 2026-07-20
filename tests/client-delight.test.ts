import assert from "node:assert/strict";
import test from "node:test";

import { runtimeMotionCue } from "../apps/client/src/motion-delight.js";
import { attachSoundFeedback, soundVoicesFor } from "../apps/client/src/sound-feedback.js";
import type { RuntimeEvent } from "../packages/runtime/src/runtime-events.js";

test("sound cues are short, local, and reserved for meaningful feedback", () => {
  assert.deepEqual(soundVoicesFor("input_accepted"), []);
  assert.deepEqual(soundVoicesFor("state_changed"), []);
  assert.ok(soundVoicesFor("pickup").length >= 1);
  assert.ok(soundVoicesFor("win").length > soundVoicesFor("pickup").length);

  for (const kind of ["pickup", "unlock", "damage", "projectile", "win", "lose"] as const) {
    for (const voice of soundVoicesFor(kind)) {
      assert.ok(voice.frequency > 0);
      assert.ok(voice.delayMs >= 0);
      assert.ok(voice.durationMs > 0 && voice.durationMs <= 330);
      assert.ok(voice.gain > 0 && voice.gain < 0.05);
    }
  }
});

test("motion cues enhance presentation without responding to simulation evidence", () => {
  assert.equal(runtimeMotionCue("input_accepted"), null);
  assert.equal(runtimeMotionCue("state_changed"), null);
  assert.equal(runtimeMotionCue("surface_landed"), null);
  assert.equal(runtimeMotionCue("pickup")?.target, "status");
  assert.equal(runtimeMotionCue("damage")?.target, "shell");
  assert.equal(runtimeMotionCue("assist_activated")?.target, "controls");
});

test("sound waits for a gesture and persists an unambiguous mute state", () => {
  class FakeButton extends EventTarget {
    textContent = "";
    readonly attributes = new Map<string, string>();
    setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
    querySelector(): null { return null; }
  }
  const button = new FakeButton();
  const saved = new Map<string, string>();
  let contextsCreated = 0;
  let voicesStarted = 0;
  const parameter = {
    setValueAtTime(): void {},
    exponentialRampToValueAtTime(): void {},
  };
  const context = {
    currentTime: 1,
    state: "running",
    destination: {},
    createOscillator: () => ({
      type: "sine",
      frequency: parameter,
      connect(): void {},
      start(): void { voicesStarted += 1; },
      stop(): void {},
    }),
    createGain: () => ({ gain: parameter, connect(): void {} }),
    resume: async () => undefined,
    suspend: async () => undefined,
    close: async () => undefined,
  } as unknown as AudioContext;
  const controller = attachSoundFeedback({
    button: button as unknown as HTMLButtonElement,
    eventTarget: button,
    storage: {
      getItem: (key) => saved.get(key) ?? null,
      setItem: (key, value) => { saved.set(key, value); },
    },
    createAudioContext: () => {
      contextsCreated += 1;
      return context;
    },
    isUserGesture: () => true,
  });
  const pickup = {
    format: "inkling-runtime-event-v1",
    sequence: 1,
    frame: 10,
    kind: "pickup",
    entityId: "item",
    required: true,
    state: {
      status: "playing",
      lives: 3,
      collected: 1,
      collectibleTotal: 2,
      assistAvailable: false,
      assistActive: false,
    },
  } satisfies RuntimeEvent;

  controller.handleRuntimeEvent(pickup);
  assert.equal(contextsCreated, 0, "audio context was created before a gesture");
  button.dispatchEvent(new Event("pointerdown"));
  assert.equal(contextsCreated, 1);
  controller.handleRuntimeEvent(pickup);
  assert.equal(voicesStarted, 2);

  button.dispatchEvent(new Event("click"));
  assert.equal(controller.isMuted(), true);
  assert.equal(button.attributes.get("aria-label"), "Game sounds");
  assert.equal(button.attributes.get("aria-pressed"), "false");
  assert.equal([...saved.values()][0], "true");
  controller.handleRuntimeEvent(pickup);
  assert.equal(voicesStarted, 2, "muted sound still played");
  controller.destroy();
});
