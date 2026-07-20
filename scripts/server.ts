import { createHmac, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";

import { createDrawingGenerationStreamHandler } from "../services/gen/src/http.js";
import { GenerationAdmissionController } from "../services/gen/src/generation-admission.js";
import { findProjectRoot } from "../runner/spec.js";

const MAX_REQUEST_BYTES = 12 * 1024 * 1024;
const SESSION_COOKIE = "inkling_session";
const RATE_WINDOW_MS = 60 * 60 * 1_000;
const MAX_GENERATIONS_PER_WINDOW = 8;
const MAX_CONCURRENT_GENERATIONS = 4;
const MAX_GENERATION_MS = 8 * 60 * 1_000;
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
const configuredSessionSecret = process.env.INKLING_SESSION_SECRET;

if (!process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY is required by the production generation service");
}
if (!configuredSessionSecret || configuredSessionSecret.length < 32) {
  throw new Error("INKLING_SESSION_SECRET must contain at least 32 characters");
}
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer from 1 to 65535");
}
const sessionSecret = configuredSessionSecret;

const root = findProjectRoot();
const publicRoot = resolve(root, "build/client");
const generationAdmission = new GenerationAdmissionController(
  MAX_CONCURRENT_GENERATIONS,
  MAX_GENERATIONS_PER_WINDOW,
  RATE_WINDOW_MS,
);
const configuredBuildRevision = process.env.INKLING_BUILD_REVISION ?? process.env.RAILWAY_GIT_COMMIT_SHA;
if (!configuredBuildRevision || !/^[a-f0-9]{7,64}$/i.test(configuredBuildRevision)) {
  throw new Error("INKLING_BUILD_REVISION or RAILWAY_GIT_COMMIT_SHA must contain an immutable commit hash");
}
const buildRevision = configuredBuildRevision;

function cookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, value] = part.trim().split("=", 2);
    if (key === name && value) return value;
  }
  return undefined;
}

function firstForwarded(value: string | string[] | undefined): string | undefined {
  const source = Array.isArray(value) ? value[0] : value;
  return source?.split(",", 1)[0]?.trim() || undefined;
}

function requestFromNode(request: IncomingMessage, body?: Buffer, signal?: AbortSignal): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  const forwardedProtocol = firstForwarded(request.headers["x-forwarded-proto"]);
  const protocol = forwardedProtocol === "https" ? "https" : "http";
  const forwardedHost = firstForwarded(request.headers["x-forwarded-host"]);
  const requestHost = forwardedHost ?? request.headers.host ?? `127.0.0.1:${port}`;
  const init: RequestInit = { method: request.method ?? "GET", headers };
  if (signal) init.signal = signal;
  if (body && body.length > 0) init.body = body.toString("utf8");
  return new Request(`${protocol}://${requestHost}${request.url ?? "/"}`, init);
}

function appendSessionCookie(response: ServerResponse, session: string): void {
  response.setHeader(
    "set-cookie",
    `${SESSION_COOKIE}=${session}; HttpOnly; Secure; SameSite=Strict; Path=/`,
  );
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("x-inkling-revision", buildRevision);
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("cross-origin-opener-policy", "same-origin");
  response.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
  response.setHeader(
    "permissions-policy",
    "camera=(self), microphone=(), geolocation=(), payment=(), usb=()",
  );
  response.setHeader(
    "content-security-policy",
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
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

async function writeWebResponse(response: ServerResponse, result: Response): Promise<void> {
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

function sessionKey(request: Request): string | undefined {
  const session = cookie(request, SESSION_COOKIE);
  return session ? createHmac("sha256", sessionSecret).update(session).digest("hex") : undefined;
}

const generationHandler = createDrawingGenerationStreamHandler({
  resolveSafetyId(request) {
    return sessionKey(request);
  },
});

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".css": return "text/css; charset=utf-8";
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".png": return "image/png";
    case ".svg": return "image/svg+xml";
    case ".txt": return "text/plain; charset=utf-8";
    case ".webp": return "image/webp";
    default: return "application/octet-stream";
  }
}

function safePublicPath(pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) return undefined;
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const target = resolve(publicRoot, relative);
  return target === publicRoot || target.startsWith(`${publicRoot}${sep}`) ? target : undefined;
}

async function servePublicFile(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }
  const requested = safePublicPath(pathname);
  if (!requested) {
    response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "invalid_path" }));
    return;
  }

  let target = requested;
  let bytes: Buffer;
  try {
    bytes = await readFile(target);
  } catch {
    if (extname(pathname)) {
      response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    target = resolve(publicRoot, "index.html");
    bytes = await readFile(target);
  }

  const requestUrl = requestFromNode(request);
  if (target === resolve(publicRoot, "index.html") && !cookie(requestUrl, SESSION_COOKIE)) {
    appendSessionCookie(response, randomBytes(32).toString("hex"));
  }
  response.statusCode = 200;
  response.setHeader("content-type", contentType(target));
  response.setHeader("content-length", String(bytes.length));
  response.setHeader(
    "cache-control",
    pathname.startsWith("/assets/")
      ? "public, max-age=31536000, immutable"
      : "no-store",
  );
  response.end(request.method === "HEAD" ? undefined : bytes);
}

const server = createHttpServer(async (request, response) => {
  setSecurityHeaders(response);
  const requestUrl = requestFromNode(request);
  const pathname = new URL(requestUrl.url).pathname;

  if (pathname === "/healthz") {
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify({ status: "ok", revision: buildRevision }));
    return;
  }

  if (pathname === "/api/games/drawing") {
    const key = sessionKey(requestUrl);
    if (!key) {
      rejectUpload(request, response, 401, "missing_session");
      return;
    }
    const admission = generationAdmission.begin(key);
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
      await writeWebResponse(response, await generationHandler(requestFromNode(request, body, disconnect.signal)));
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
    return;
  }

  try {
    await servePublicFile(request, response, pathname);
  } catch {
    if (!response.headersSent) {
      response.writeHead(500, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
    }
    response.end(JSON.stringify({ error: "server_unavailable" }));
  }
});

server.requestTimeout = 12 * 60 * 1_000;
server.headersTimeout = 60 * 1_000;
server.keepAliveTimeout = 65 * 1_000;
server.listen(port, host, () => {
  console.log(`Inkling production server listening on ${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}
