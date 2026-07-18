import { runDrawingScan } from "../../../runner/pipeline.js";
import type { RunnerOptions, ScanResult } from "../../../runner/types.js";
import {
  createPlayableGameDocument,
  type PlayableGameDocument,
} from "../../../packages/runtime/src/artwork.js";

const INLINE_IMAGE = /^data:image\/(?:gif|jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/i;
const SHA256_IDENTIFIER = /^[a-f0-9]{64}$/i;
const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export interface DrawingGenerationRequest {
  /** Cropped on-device image data. Remote URLs are deliberately not accepted. */
  image: string;
  /** Per-user privacy-preserving identifier supplied by the authenticated service boundary. */
  safetyId: string;
  context?: unknown;
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
  const maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
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
    }),
  };
}
