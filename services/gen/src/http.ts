import { PipelineBlocked, SolvabilityError } from "../../../runner/pipeline.js";
import {
  generateDrawingGame,
  type DrawingGenerationOptions,
} from "./drawing-service.js";
import {
  buildFailedQualityRecord,
  buildPlayableQualityRecord,
  type GenerationQualityRecord,
} from "./quality-metrics.js";

export interface DrawingGenerationHttpOptions extends DrawingGenerationOptions {
  /**
   * Deployment code derives this from an authenticated/anonymous server
   * session. The browser never supplies the safety identifier in JSON.
   */
  resolveSafetyId(request: Request): Promise<string | undefined> | string | undefined;
  /**
   * Operator-only observability. The record carries anonymous quality
   * evidence and is never written into any client-visible response.
   */
  onGenerationRecord?(record: GenerationQualityRecord): void;
}

export interface DrawingGenerationProgressEvent {
  type: "progress" | "complete" | "error";
  requestId: string;
  stage?: "checking" | "understanding" | "animating" | "testing";
  playableGame?: unknown;
  error?: "drawing_not_approved" | "game_not_finishable" | "invalid_drawing_request" | "generation_unavailable";
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  // Non-browser integrations do not always send Origin. SameSite=Strict is
  // still required at the deployment session boundary; when a browser does
  // send Origin, reject cross-origin uploads before the image is parsed.
  return !origin || origin === new URL(request.url).origin;
}

function publicError(error: unknown): NonNullable<DrawingGenerationProgressEvent["error"]> {
  if (error instanceof PipelineBlocked) return "drawing_not_approved";
  if (error instanceof SolvabilityError) return "game_not_finishable";
  if (error instanceof Error && (
    error.message.startsWith("Drawing input") ||
    error.message.startsWith("maxImageBytes") ||
    error.message.startsWith("safetyId")
  )) return "invalid_drawing_request";
  return "generation_unavailable";
}

function stageForCall(callId: string): NonNullable<DrawingGenerationProgressEvent["stage"]> {
  if (callId === "P1") return "checking";
  // P10 merges the rescanned paper into the existing world — for the child,
  // that is still "understanding" their drawing, in the same coarse vocabulary.
  if (callId === "P0_calibrate" || callId === "P2" || callId === "P2_photo" || callId === "P6" || callId === "P10") {
    return "understanding";
  }
  if (callId === "P3" || callId === "P4" || callId === "P5" || callId === "P7") return "animating";
  return "testing";
}

const MAX_CORRECTIONS = 6;
const MAX_CORRECTION_LENGTH = 240;

async function requestPayload(
  request: Request,
  options: DrawingGenerationHttpOptions,
): Promise<
  | {
    image: string;
    safetyId: string;
    requestId: string;
    corrections?: string[];
    previousGame?: Record<string, unknown>;
  }
  | Response
> {
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
  if (!isSameOriginRequest(request)) return json(403, { error: "cross_origin_request" });
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return json(415, { error: "unsupported_media_type" });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  if (
    !isRecord(payload) ||
    typeof payload.image !== "string" ||
    typeof payload.request_id !== "string" ||
    !/^[A-Za-z0-9_-]{16,80}$/.test(payload.request_id)
  ) {
    return json(400, { error: "invalid_drawing_request" });
  }

  // Corrections are the model's own previously returned guesses, echoed back
  // when the child rejects one. Bound them tightly; they re-derive the whole
  // game through every ordered gate, never patch it.
  let corrections: string[] | undefined;
  if (payload.corrections !== undefined) {
    const candidate = payload.corrections;
    const valid = Array.isArray(candidate) &&
      candidate.length > 0 &&
      candidate.length <= MAX_CORRECTIONS &&
      candidate.every((item) =>
        typeof item === "string" && item.trim().length > 0 && item.length <= MAX_CORRECTION_LENGTH,
      );
    if (!valid) return json(400, { error: "invalid_drawing_request" });
    corrections = candidate as string[];
  }

  // A rescan carries the prior playable document so the child's world can
  // grow instead of restarting. Only self-contained v1 documents pass this
  // boundary; deep validation (GameSpec shape, inline-only artwork) happens
  // at the service layer before any model call.
  let previousGame: Record<string, unknown> | undefined;
  if (payload.previous_game !== undefined) {
    if (
      !isRecord(payload.previous_game) ||
      payload.previous_game.format !== "inkling-playable-game-v1"
    ) {
      return json(400, { error: "invalid_drawing_request" });
    }
    previousGame = payload.previous_game;
  }

  const safetyId = await options.resolveSafetyId(request);
  if (!safetyId) return json(401, { error: "missing_session" });
  return {
    image: payload.image,
    safetyId,
    requestId: payload.request_id,
    ...(corrections ? { corrections } : {}),
    ...(previousGame ? { previousGame } : {}),
  };
}

/**
 * A minimal same-origin HTTP adapter. Hosting/framework code is intentionally
 * outside this module; it must supply authentication, rate limiting, request
 * size limits, retention/deletion policy, and a privacy-preserving safety id.
 */
export function createDrawingGenerationHandler(
  options: DrawingGenerationHttpOptions,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const payload = await requestPayload(request, options);
    if (payload instanceof Response) return payload;

    try {
      const result = await generateDrawingGame(
        // An anonymous child flow sends only the prepared image plus, at most,
        // its own echoed-back guesses to correct and its own prior playable
        // document to grow. Deliberately do not forward arbitrary browser
        // metadata into model prompts.
        {
          image: payload.image,
          safetyId: payload.safetyId,
          ...(payload.corrections ? { context: { corrections: payload.corrections } } : {}),
          ...(payload.previousGame ? { previousGame: payload.previousGame } : {}),
        },
        { ...options, signal: request.signal },
      );
      return json(201, { requestId: payload.requestId, playableGame: result.playableGame });
    } catch (error) {
      const code = publicError(error);
      const status = code === "drawing_not_approved" || code === "game_not_finishable" ? 422
        : code === "invalid_drawing_request" ? 400 : 502;
      return json(status, { error: code });
    }
  };
}

/**
 * Emits only child-safe, coarse progress stages while the mandatory pipeline
 * runs. No model text, image data, identifier, or internal reasoning is sent
 * back over this event stream.
 */
export function createDrawingGenerationStreamHandler(
  options: DrawingGenerationHttpOptions,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const payload = await requestPayload(request, options);
    if (payload instanceof Response) return payload;
    const encoder = new TextEncoder();
    const stageOrder = ["checking", "understanding", "animating", "testing"] as const;
    const streamAbort = new AbortController();
    const forwardRequestAbort = (): void => {
      streamAbort.abort(request.signal.reason);
    };
    if (request.signal.aborted) forwardRequestAbort();
    else request.signal.addEventListener("abort", forwardRequestAbort, { once: true });
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let highestStage = -1;
        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": keep-alive\n\n"));
          } catch {
            streamAbort.abort(new Error("generation_stream_closed"));
          }
        }, 15_000);
        const emit = (event: Omit<DrawingGenerationProgressEvent, "requestId">): void => {
          if (event.type === "progress" && event.stage) {
            const index = stageOrder.indexOf(event.stage);
            if (index < highestStage) return;
            highestStage = index;
          }
          const boundEvent: DrawingGenerationProgressEvent = { ...event, requestId: payload.requestId };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(boundEvent)}\n\n`));
        };
        emit({ type: "progress", stage: "checking" });
        const generationStartedAt = performance.now();
        const recordQuality = (record: GenerationQualityRecord): void => {
          try {
            options.onGenerationRecord?.(record);
          } catch {
            // Observability must never break or delay a child's generation.
          }
        };
        try {
          const result = await generateDrawingGame({
            image: payload.image,
            safetyId: payload.safetyId,
            ...(payload.corrections ? { context: { corrections: payload.corrections } } : {}),
            ...(payload.previousGame ? { previousGame: payload.previousGame } : {}),
          }, {
            ...options,
            signal: streamAbort.signal,
            onRequest(trace, modelRequest) {
              options.onRequest?.(trace, modelRequest);
              emit({ type: "progress", stage: stageForCall(trace.callId) });
            },
          });
          recordQuality(buildPlayableQualityRecord(result.scan, result.playableGame));
          emit({ type: "complete", playableGame: result.playableGame });
        } catch (error) {
          recordQuality(buildFailedQualityRecord(
            publicError(error),
            performance.now() - generationStartedAt,
          ));
          if (!streamAbort.signal.aborted) {
            try {
              emit({ type: "error", error: publicError(error) });
            } catch {
              // The client is already gone; never turn cancellation into an
              // unhandled stream exception or a second model attempt.
            }
          }
        } finally {
          clearInterval(heartbeat);
          request.signal.removeEventListener("abort", forwardRequestAbort);
          try {
            controller.close();
          } catch {
            // A cancelled reader has already closed its side of the stream.
          }
        }
      },
      cancel() {
        streamAbort.abort(new Error("generation_stream_cancelled"));
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });
  };
}
