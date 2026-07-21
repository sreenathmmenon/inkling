import type { IncomingMessage, ServerResponse } from "node:http";

import { GenerationAdmissionController } from "./generation-admission.js";
import { MAX_REQUEST_BYTES } from "./image-limits.js";

/**
 * One admission policy for every HTTP server that fronts generation. The
 * development server deliberately runs the same rate, concurrency, deadline,
 * and body-size gates as production so production is never a surprise.
 */
export const GENERATION_RATE_WINDOW_MS = 60 * 60 * 1_000;
// Effectively unlimited for a real person; still a ceiling against runaway
// scripts. Raised from 8 for live-demo sessions at the owner's direction.
export const MAX_GENERATIONS_PER_WINDOW = 100;
export const MAX_CONCURRENT_GENERATIONS = 4;
export const MAX_GENERATION_MS = 8 * 60 * 1_000;

export function createGenerationAdmission(): GenerationAdmissionController {
  return new GenerationAdmissionController(
    MAX_CONCURRENT_GENERATIONS,
    MAX_GENERATIONS_PER_WINDOW,
    GENERATION_RATE_WINDOW_MS,
  );
}

function rejectUpload(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  error: string,
  retryAfter?: string,
): void {
  // The browser may still be streaming a multi-megabyte drawing when an
  // authorization, capacity, or rate gate rejects it. Keep consuming those
  // bytes so reverse proxies can deliver the JSON response instead of
  // resetting the HTTP/2 stream as a protocol error.
  request.resume();
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...(retryAfter ? { "retry-after": retryAfter } : {}),
  });
  response.end(JSON.stringify({ error }));
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new Error("request_too_large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export async function writeWebResponse(response: ServerResponse, result: Response): Promise<void> {
  for (const [key, value] of result.headers) response.setHeader(key, value);
  response.statusCode = result.status;
  if (!result.body) {
    response.end();
    return;
  }
  const reader = result.body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      response.write(next.value);
    }
  } finally {
    reader.releaseLock();
    response.end();
  }
}

export interface AdmittedGenerationOptions {
  admission: GenerationAdmissionController;
  /** Privacy-preserving per-session key; absent means no session cookie. */
  sessionKey: string | undefined;
  /** Builds the WHATWG request handed to the generation stream handler. */
  toWebRequest(body: Buffer, signal: AbortSignal): Request;
  handler(request: Request): Promise<Response>;
}

/**
 * Admits, deadlines, and streams one generation upload. Every rejection —
 * missing session, rate limit, capacity, oversized body — happens here, once,
 * with the same status and message on every server.
 */
export async function handleAdmittedGeneration(
  request: IncomingMessage,
  response: ServerResponse,
  options: AdmittedGenerationOptions,
): Promise<void> {
  const key = options.sessionKey;
  if (!key) {
    rejectUpload(request, response, 401, "missing_session");
    return;
  }
  const admission = options.admission.begin(key);
  if (!admission.accepted) {
    const rateLimited = admission.reason === "rate_limited";
    rejectUpload(
      request,
      response,
      rateLimited ? 429 : 503,
      rateLimited ? "generation_rate_limited" : "generation_busy",
      rateLimited ? "3600" : "30",
    );
    return;
  }
  const lease = admission.lease;
  const disconnect = lease.controller;
  const generationDeadline = setTimeout(() => {
    disconnect.abort(new Error("generation_deadline_exceeded"));
  }, MAX_GENERATION_MS);
  generationDeadline.unref();
  const abortDisconnectedGeneration = (): void => {
    if (!response.writableEnded) disconnect.abort(new Error("client_disconnected"));
  };
  request.once("aborted", abortDisconnectedGeneration);
  response.once("close", abortDisconnectedGeneration);
  try {
    const body = await readRequestBody(request);
    await lease.activate();
    await writeWebResponse(response, await options.handler(options.toWebRequest(body, disconnect.signal)));
  } catch (error) {
    const status = error instanceof Error && error.message === "request_too_large" ? 413 : 500;
    if (!response.headersSent) {
      response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({
        error: status === 413 ? "request_too_large" : "generation_unavailable",
      }));
    } else {
      response.end();
    }
  } finally {
    clearTimeout(generationDeadline);
    request.off("aborted", abortDisconnectedGeneration);
    response.off("close", abortDisconnectedGeneration);
    lease.release();
  }
}
