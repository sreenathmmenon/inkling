import { createHmac, randomBytes } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";

import { createServer as createViteServer } from "vite";

import { createDrawingGenerationStreamHandler } from "../services/gen/src/http.js";
import {
  createGenerationAdmission,
  handleAdmittedGeneration,
} from "../services/gen/src/server-admission.js";
import { findProjectRoot } from "../runner/spec.js";

const SESSION_COOKIE = "inkling_dev_session";
const port = Number(process.env.PORT ?? 5173);

if (!process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY is missing; add it to .env before starting the local generation server");
}
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer from 1 to 65535");
}

function cookie(request: Request, name: string): string | undefined {
  const source = request.headers.get("cookie") ?? "";
  for (const part of source.split(";")) {
    const [key, value] = part.trim().split("=", 2);
    if (key === name && value) return value;
  }
  return undefined;
}

function appendCookie(response: ServerResponse, value: string): void {
  const existing = response.getHeader("set-cookie");
  const cookies = Array.isArray(existing) ? existing : existing ? [String(existing)] : [];
  // This is intentionally a session cookie: local anonymous play creates no
  // durable account identifier. Production HTTPS infrastructure must set
  // Secure as well as its approved retention and deletion controls.
  cookies.push(`${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/`);
  response.setHeader("set-cookie", cookies);
}

function setPrivacyHeaders(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("cross-origin-opener-policy", "same-origin");
  response.setHeader("permissions-policy", "camera=(self), microphone=(), geolocation=(), payment=(), usb=()");
  response.setHeader(
    "content-security-policy",
    // Vite's development-only HMR socket is limited to loopback. Production
    // hosting must not copy this exception and should use `connect-src 'self'`.
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*",
  );
}

function requestFromNode(request: IncomingMessage, body: Buffer, signal?: AbortSignal): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  const method = request.method ?? "GET";
  const init: RequestInit = {
    method,
    headers,
  };
  if (signal) init.signal = signal;
  if (body.length > 0) init.body = body.toString("utf8");
  // Keep the browser-visible host. Rewriting localhost to 127.0.0.1 makes a
  // genuinely same-origin browser upload look cross-origin to the safety
  // handler, which must then reject it by design.
  const host = request.headers.host || `127.0.0.1:${port}`;
  return new Request(`http://${host}${request.url ?? "/"}`, init);
}

const root = findProjectRoot();
const sessionSecret = randomBytes(32);
// The same rate, concurrency, deadline, and body-size gates as production:
// development must exercise identical admission control so production
// behavior is never a surprise.
const generationAdmission = createGenerationAdmission();
function safetyId(request: Request): string | undefined {
  const session = cookie(request, SESSION_COOKIE);
  return session ? createHmac("sha256", sessionSecret).update(session).digest("hex") : undefined;
}
const handler = createDrawingGenerationStreamHandler({
  resolveSafetyId(request) {
    return safetyId(request);
  },
});
const vite = await createViteServer({
  root: resolve(root, "apps/client"),
  appType: "spa",
  // The combined local server intentionally runs without HMR. It prevents a
  // second local Inkling instance from claiming Vite's shared websocket port
  // and keeps capture/browser validation free of dev-console errors.
  server: { middlewareMode: true, hmr: false, ws: false },
  define: { __INKLING_GAMESPEC__: "null" },
});
const server = createHttpServer(async (request, response) => {
  setPrivacyHeaders(response);
  const path = new URL(request.url ?? "/", `http://127.0.0.1:${port}`).pathname;
  // Vite injects its client module into transformed HTML even with HMR disabled
  // in middleware mode. Serve a harmless module here so a second local Inkling
  // instance cannot emit failed websocket errors during browser validation.
  if (path === "/@vite/client") {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
    response.end("export {};");
    return;
  }
  if (path === "/api/games/drawing") {
    await handleAdmittedGeneration(request, response, {
      admission: generationAdmission,
      sessionKey: safetyId(requestFromNode(request, Buffer.alloc(0))),
      toWebRequest: (body, signal) => requestFromNode(request, body, signal),
      handler,
    });
    return;
  }

  const hasSession = request.headers.cookie?.includes(`${SESSION_COOKIE}=`);
  if (!hasSession) appendCookie(response, randomBytes(24).toString("hex"));
  vite.middlewares(request, response, (error: unknown) => {
    response.statusCode = 500;
    response.end(error ? String(error) : "Vite middleware did not handle this request");
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Inkling dev server: http://127.0.0.1:${port}`);
  console.log("The browser has no API key; scan requests use the server-side P1 → generation → P8 flow.");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void vite.close().finally(() => server.close(() => process.exit(0)));
  });
}
