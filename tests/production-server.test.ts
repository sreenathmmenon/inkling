import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import test from "node:test";

import { findProjectRoot } from "../runner/spec.js";

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return address.port;
}

async function waitUntilReady(url: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`production server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/healthz`);
      if (response.ok) return;
    } catch {
      // The loop is bounded and used only for local child-process startup.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("production server did not become ready");
}

test("production server fails closed around anonymous sessions and browser data", async (t) => {
  const root = findProjectRoot();
  const port = await availablePort();
  const child = spawn(process.execPath, [resolve(root, "dist/scripts/server.js")], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      OPENAI_API_KEY: "test-only-not-a-real-key",
      INKLING_SESSION_SECRET: "test-only-session-secret-at-least-32-characters",
    },
    stdio: "ignore",
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGTERM");
  });

  const origin = `http://127.0.0.1:${port}`;
  await waitUntilReady(origin, child);
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.equal(page.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.match(page.headers.get("strict-transport-security") ?? "", /max-age=31536000/);
  assert.match(page.headers.get("content-security-policy") ?? "", /connect-src 'self'/);
  assert.match(page.headers.get("permissions-policy") ?? "", /microphone=\(\)/);
  assert.match(page.headers.get("set-cookie") ?? "", /HttpOnly; Secure; SameSite=Strict/);

  const noSession = await fetch(`${origin}/api/games/drawing`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ image: "data:image/png;base64,aGVsbG8=", request_id: "missing-session" }),
  });
  assert.equal(noSession.status, 401);
  assert.equal(noSession.headers.get("cache-control"), "no-store");
  assert.deepEqual(await noSession.json(), { error: "missing_session" });

  const largeRejectedUpload = await fetch(`${origin}/api/games/drawing`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ image: `data:image/png;base64,${"a".repeat(5 * 1024 * 1024)}`, request_id: "large-missing-session" }),
  });
  assert.equal(largeRejectedUpload.status, 401);
  assert.deepEqual(await largeRejectedUpload.json(), { error: "missing_session" });
});
