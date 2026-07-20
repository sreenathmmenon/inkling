import type { RuntimeEvent, RuntimeEventKind } from "../../../packages/runtime/src/runtime-events.js";

const SOUND_PREFERENCE_KEY = "inkling:game-sound-muted-v1";

interface ToneVoice {
  frequency: number;
  endFrequency?: number;
  delayMs: number;
  durationMs: number;
  gain: number;
  wave: OscillatorType;
}

export interface SoundFeedbackController {
  handleRuntimeEvent(event: RuntimeEvent): void;
  isMuted(): boolean;
  destroy(): void;
}

interface SoundFeedbackOptions {
  button: HTMLButtonElement;
  eventTarget?: EventTarget;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  createAudioContext?: () => AudioContext | undefined;
  isUserGesture?: (event: Event) => boolean;
}

/**
 * Short synthesized cues are local, deterministic, and require no download.
 * Their timing is presentation-only and never feeds back into the game loop.
 */
export function soundVoicesFor(kind: RuntimeEventKind): readonly ToneVoice[] {
  switch (kind) {
    case "pickup":
      return [
        { frequency: 660, endFrequency: 880, delayMs: 0, durationMs: 90, gain: 0.038, wave: "sine" },
        { frequency: 880, endFrequency: 1_100, delayMs: 75, durationMs: 120, gain: 0.034, wave: "sine" },
      ];
    case "unlock":
      return [
        { frequency: 523, delayMs: 0, durationMs: 190, gain: 0.025, wave: "triangle" },
        { frequency: 659, delayMs: 35, durationMs: 190, gain: 0.022, wave: "triangle" },
        { frequency: 784, delayMs: 70, durationMs: 230, gain: 0.02, wave: "triangle" },
      ];
    case "assist_available":
    case "assist_activated":
      return [
        { frequency: 494, endFrequency: 740, delayMs: 0, durationMs: 180, gain: 0.028, wave: "sine" },
      ];
    case "stuck_cue":
    case "goal_blocked":
      return [
        { frequency: 392, delayMs: 0, durationMs: 90, gain: 0.022, wave: "triangle" },
        { frequency: 392, delayMs: 125, durationMs: 90, gain: 0.018, wave: "triangle" },
      ];
    case "damage":
      return [
        { frequency: 190, endFrequency: 120, delayMs: 0, durationMs: 210, gain: 0.035, wave: "triangle" },
      ];
    case "projectile":
      return [
        { frequency: 760, endFrequency: 1_020, delayMs: 0, durationMs: 75, gain: 0.018, wave: "sine" },
      ];
    case "win":
      return [
        { frequency: 523, delayMs: 0, durationMs: 180, gain: 0.032, wave: "triangle" },
        { frequency: 659, delayMs: 105, durationMs: 190, gain: 0.03, wave: "triangle" },
        { frequency: 784, delayMs: 210, durationMs: 210, gain: 0.03, wave: "triangle" },
        { frequency: 1_047, delayMs: 330, durationMs: 330, gain: 0.026, wave: "sine" },
      ];
    case "lose":
      return [
        { frequency: 330, endFrequency: 260, delayMs: 0, durationMs: 180, gain: 0.024, wave: "sine" },
        { frequency: 260, endFrequency: 196, delayMs: 155, durationMs: 230, gain: 0.021, wave: "sine" },
      ];
    default:
      return [];
  }
}

function defaultAudioContext(): AudioContext | undefined {
  const audioWindow = window as typeof window & {
    webkitAudioContext?: typeof AudioContext;
  };
  const Context = audioWindow.AudioContext ?? audioWindow.webkitAudioContext;
  if (!Context) return undefined;
  return new Context({ latencyHint: "interactive" });
}

function defaultStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readMuted(storage: SoundFeedbackOptions["storage"]): boolean {
  try {
    return storage?.getItem(SOUND_PREFERENCE_KEY) === "true";
  } catch {
    return false;
  }
}

function persistMuted(storage: SoundFeedbackOptions["storage"], muted: boolean): void {
  try {
    storage?.setItem(SOUND_PREFERENCE_KEY, String(muted));
  } catch {
    // Private browsing and embedded contexts can reject storage. Sound still
    // remains a safe, in-memory preference for this page.
  }
}

function playVoice(context: AudioContext, voice: ToneVoice): void {
  const start = context.currentTime + voice.delayMs / 1_000;
  const end = start + voice.durationMs / 1_000;
  const oscillator = context.createOscillator();
  const envelope = context.createGain();
  oscillator.type = voice.wave;
  oscillator.frequency.setValueAtTime(voice.frequency, start);
  if (voice.endFrequency !== undefined) {
    oscillator.frequency.exponentialRampToValueAtTime(voice.endFrequency, end);
  }
  envelope.gain.setValueAtTime(0.0001, start);
  envelope.gain.exponentialRampToValueAtTime(voice.gain, start + 0.018);
  envelope.gain.exponentialRampToValueAtTime(0.0001, end);
  oscillator.connect(envelope);
  envelope.connect(context.destination);
  oscillator.start(start);
  oscillator.stop(end + 0.02);
}

export function attachSoundFeedback(options: SoundFeedbackOptions): SoundFeedbackController {
  const target = options.eventTarget ?? window;
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const contextFactory = options.createAudioContext ?? defaultAudioContext;
  const isUserGesture = options.isUserGesture ?? ((event: Event) => event.isTrusted);
  let muted = readMuted(storage);
  let gestureSeen = false;
  let context: AudioContext | undefined;

  const renderPreference = (): void => {
    const label = options.button.querySelector<HTMLElement>("[data-sound-label]");
    if (label) label.textContent = muted ? "Sound: Off" : "Sound: On";
    else options.button.textContent = muted ? "Sound: Off" : "Sound: On";
    const soundOn = options.button.querySelector<SVGElement>("[data-sound-on]");
    const soundOff = options.button.querySelector<SVGElement>("[data-sound-off]");
    if (soundOn) {
      if (muted) soundOn.setAttribute("hidden", "");
      else soundOn.removeAttribute("hidden");
    }
    if (soundOff) {
      if (muted) soundOff.removeAttribute("hidden");
      else soundOff.setAttribute("hidden", "");
    }
    // A stable label lets aria-pressed communicate state without producing
    // contradictory announcements such as “Mute game sounds, pressed”.
    options.button.setAttribute("aria-label", "Game sounds");
    options.button.setAttribute("aria-pressed", String(!muted));
  };

  const ensureContext = (): AudioContext | undefined => {
    if (!gestureSeen || muted) return undefined;
    try {
      context ??= contextFactory();
      if (context?.state === "suspended") void context.resume().catch(() => undefined);
      return context;
    } catch {
      return undefined;
    }
  };

  const noteGesture: EventListener = (event) => {
    if (!isUserGesture(event)) return;
    gestureSeen = true;
    ensureContext();
  };
  for (const type of ["pointerdown", "touchstart", "keydown", "click"]) {
    target.addEventListener(type, noteGesture, { capture: true, passive: true });
  }

  const toggleSound = (): void => {
    muted = !muted;
    persistMuted(storage, muted);
    renderPreference();
    if (muted) {
      try {
        if (context?.state === "running") void context.suspend().catch(() => undefined);
      } catch {
        // Audio is optional and must never interrupt play.
      }
    } else {
      ensureContext();
    }
  };
  options.button.addEventListener("click", toggleSound);
  renderPreference();

  return {
    handleRuntimeEvent(event): void {
      if (muted || !gestureSeen) return;
      const voices = soundVoicesFor(event.kind);
      if (!voices.length) return;
      const activeContext = ensureContext();
      if (!activeContext || activeContext.state !== "running") return;
      try {
        for (const voice of voices) playVoice(activeContext, voice);
      } catch {
        // Browsers may revoke audio resources at any time. Gameplay continues.
      }
    },
    isMuted: () => muted,
    destroy(): void {
      options.button.removeEventListener("click", toggleSound);
      for (const type of ["pointerdown", "touchstart", "keydown", "click"]) {
        target.removeEventListener(type, noteGesture, { capture: true });
      }
      try {
        void context?.close().catch(() => undefined);
      } catch {
        // Teardown is best effort.
      }
      context = undefined;
    },
  };
}
