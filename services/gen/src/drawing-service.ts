import { isGameSpec, runDrawingScan, runMultipageStitch } from "../../../runner/pipeline.js";
import type { GameSpec, RunnerOptions, ScanResult } from "../../../runner/types.js";
import {
  createPlayableGameDocument,
  isInlineArtworkDataUrl,
  resolvePlayableGame,
  type PlayableGameDocument,
} from "../../../packages/runtime/src/artwork.js";
import type { BehaviorMotionTrack } from "../../../packages/runtime/src/behavior-track.js";

import { MAX_IMAGE_BYTES } from "./image-limits.js";

const INLINE_IMAGE = /^data:image\/(?:gif|jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/i;
const SHA256_IDENTIFIER = /^[a-f0-9]{64}$/i;

export interface DrawingGenerationRequest {
  /** Cropped on-device image data. Remote URLs are deliberately not accepted. */
  image: string;
  /** Per-user privacy-preserving identifier supplied by the authenticated service boundary. */
  safetyId: string;
  context?: unknown;
  /**
   * The prior playable document for a rescan of the child's changed paper.
   * When present, the image is treated as a new capture to stitch onto the
   * existing world; the merged spec still passes every ordered gate.
   */
  previousGame?: unknown;
}

export interface DrawingGenerationOptions {
  client?: RunnerOptions["client"];
  dryRun?: boolean;
  offline?: boolean;
  onRequest?: RunnerOptions["onRequest"];
  onResult?: RunnerOptions["onResult"];
  maxImageBytes?: number;
  signal?: AbortSignal;
}

export interface GeneratedDrawingGame {
  scan: ScanResult;
  playableGame: PlayableGameDocument;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface RescanPreviousGame {
  gameSpec: GameSpec;
  behaviorTracks: Record<string, BehaviorMotionTrack>;
  backdrop: unknown;
  soundPack: unknown;
}

/**
 * A rescan may only grow an already-earned world. The prior document is
 * re-validated here like any other untrusted input, and remote artwork is
 * rejected outright: playable documents are self-contained and network-free
 * by contract. Every failure message starts with "Drawing input" so the HTTP
 * boundary reports it as an invalid request, never a service fault.
 */
function parseRescanPreviousGame(value: unknown): RescanPreviousGame {
  if (!isRecord(value) || value.format !== "inkling-playable-game-v1") {
    throw new Error("Drawing input previous_game must be an inkling-playable-game-v1 document");
  }
  if (value.artwork !== undefined && value.artwork !== null) {
    if (!isRecord(value.artwork) || !isInlineArtworkDataUrl(value.artwork.sourceDataUrl)) {
      throw new Error("Drawing input previous_game artwork must be an inline image data URL");
    }
  }
  const resolved = resolvePlayableGame(value);
  if (!isGameSpec(resolved.gameSpec)) {
    throw new Error("Drawing input previous_game does not carry a valid GameSpec");
  }
  return {
    gameSpec: resolved.gameSpec,
    behaviorTracks: resolved.behaviorTracks,
    backdrop: value.backdrop,
    soundPack: value.soundPack,
  };
}

function inlineImageBytes(dataUrl: string): number | undefined {
  const match = INLINE_IMAGE.exec(dataUrl);
  if (!match?.[1]) return undefined;
  const payload = match[1];
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.floor((payload.length * 3) / 4) - padding;
}

/**
 * Server-side drawing generation boundary. It intentionally has no persistence
 * and no HTTP framework dependency: deployment adapters own authentication,
 * rate limiting, retention, and storage, while this function owns the ordered
 * P1 -> generation -> P8 contract.
 */
export async function generateDrawingGame(
  request: DrawingGenerationRequest,
  options: DrawingGenerationOptions = {},
): Promise<GeneratedDrawingGame> {
  if (!SHA256_IDENTIFIER.test(request.safetyId)) {
    throw new Error("safetyId must be a 64-character privacy-preserving SHA-256 hash");
  }
  const byteLength = inlineImageBytes(request.image);
  const maxImageBytes = options.maxImageBytes ?? MAX_IMAGE_BYTES;
  if (byteLength === undefined) {
    throw new Error("Drawing input must be an inline GIF, JPEG, PNG, or WebP image");
  }
  if (!Number.isSafeInteger(maxImageBytes) || maxImageBytes < 1) {
    throw new Error("maxImageBytes must be a positive integer");
  }
  if (byteLength > maxImageBytes) {
    throw new Error(`Drawing input exceeds the ${maxImageBytes}-byte service limit`);
  }

  const runnerOptions: RunnerOptions = { safetyId: request.safetyId };
  if (options.signal) runnerOptions.signal = options.signal;
  if (options.client) runnerOptions.client = options.client;
  if (options.dryRun !== undefined) runnerOptions.dryRun = options.dryRun;
  if (options.offline !== undefined) runnerOptions.offline = options.offline;
  if (options.onRequest) runnerOptions.onRequest = options.onRequest;
  if (options.onResult) runnerOptions.onResult = options.onResult;

  if (request.previousGame !== undefined) {
    const previous = parseRescanPreviousGame(request.previousGame);
    if (previous.gameSpec.primary_genre === "maze") {
      // A maze rescan exists precisely so an erased wall disappears, but
      // stitch merging demonstrably re-imposes remembered wall geometry over
      // the child's eraser, falsely sealing routes. Maze walls carry no
      // player progress, so the changed paper is re-read as a fresh faithful
      // scan through the same P1 -> generation -> P8 gates; the prior
      // backdrop and sound plans still carry forward so the world keeps its
      // character. If treasures reset, the client already says so honestly.
      const scan = await runDrawingScan(
        { image: request.image, context: request.context ?? {} },
        runnerOptions,
      );
      return {
        scan,
        playableGame: createPlayableGameDocument(scan.gameSpec, request.image, scan.assets.P3, {
          playtestReport: scan.playtestReport,
          solvability: scan.solvability,
        }, scan.behaviorTracks, {
          backdrop: previous.backdrop ?? scan.assets.P4,
          soundPack: previous.soundPack ?? scan.assets.P5,
        }),
      };
    }
    const scan = await runMultipageStitch(
      {
        gamespec_existing: previous.gameSpec,
        image_new: request.image,
        behaviorTracks: previous.behaviorTracks,
      },
      runnerOptions,
    );
    return {
      scan,
      // Reached only after the rescan passed P1, strict stitched-spec
      // validation, and the same P8 certify loop as a first scan. The new
      // capture becomes the artwork source — the child photographed the
      // changed paper — so the prior hero rig, which was fitted to the old
      // capture's coordinates, is deliberately dropped in favor of the
      // deterministic puppet fallback. The prior backdrop and sound plans
      // carry forward so the world grows instead of changing character.
      playableGame: createPlayableGameDocument(scan.gameSpec, request.image, undefined, {
        playtestReport: scan.playtestReport,
        solvability: scan.solvability,
      }, scan.behaviorTracks, {
        backdrop: previous.backdrop,
        soundPack: previous.soundPack,
      }),
    };
  }

  const scan = await runDrawingScan(
    { image: request.image, context: request.context ?? {} },
    runnerOptions,
  );
  return {
    scan,
    // This line is reached only after the runner's mandatory P1 and P8 gates.
    playableGame: createPlayableGameDocument(scan.gameSpec, request.image, scan.assets.P3, {
      playtestReport: scan.playtestReport,
      solvability: scan.solvability,
    }, scan.behaviorTracks, {
      backdrop: scan.assets.P4,
      soundPack: scan.assets.P5,
    }),
  };
}
