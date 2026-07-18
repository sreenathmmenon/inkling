import { PipelineBlocked, SolvabilityError } from "../../../runner/pipeline.js";
import {
  generateDrawingGame,
  type DrawingGenerationOptions,
} from "./drawing-service.js";

export interface DrawingGenerationHttpOptions extends DrawingGenerationOptions {
  /**
   * Deployment code derives this from an authenticated/anonymous server
   * session. The browser never supplies the safety identifier in JSON.
   */
  resolveSafetyId(request: Request): Promise<string | undefined> | string | undefined;
}

export interface DrawingGenerationProgressEvent {
  type: "progress" | "complete" | "error";
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
  if (callId === "P0_calibrate" || callId === "P2" || callId === "P2_photo" || callId === "P6") {
    return "understanding";
  }
  if (callId === "P3" || callId === "P4" || callId === "P5" || callId === "P7") return "animating";
  return "testing";
}

async function requestPayload(
  request: Request,
  options: DrawingGenerationHttpOptions,
): Promise<{ image: string; safetyId: string } | Response> {
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
  if (!isRecord(payload) || typeof payload.image !== "string") {
    return json(400, { error: "invalid_drawing_request" });
  }

  const safetyId = await options.resolveSafetyId(request);
  if (!safetyId) return json(401, { error: "missing_session" });
  return { image: payload.image, safetyId };
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
        // An anonymous child flow sends only the prepared image. Deliberately
        // do not forward arbitrary browser metadata into model prompts.
        payload,
        { ...options, signal: request.signal },
      );
      return json(201, { playableGame: result.playableGame });
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
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (event: DrawingGenerationProgressEvent): void => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        };
        emit({ type: "progress", stage: "checking" });
        try {
          const result = await generateDrawingGame(payload, {
            ...options,
            signal: request.signal,
            onRequest(trace, modelRequest) {
              options.onRequest?.(trace, modelRequest);
              emit({ type: "progress", stage: stageForCall(trace.callId) });
            },
          });
          emit({ type: "complete", playableGame: result.playableGame });
        } catch (error) {
          emit({ type: "error", error: publicError(error) });
        } finally {
          controller.close();
        }
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
