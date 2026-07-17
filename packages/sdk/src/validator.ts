import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Responses } from "openai/resources/responses/responses";

import type { BehaviorPatch } from "../../../runner/types.js";

export interface BehaviorValidation {
  valid: boolean;
  fallback: "static";
  errors: string[];
  patch?: BehaviorPatch;
}

const ALLOWED_IMPORTS = new Set([
  "@inkling/sdk",
  "@inkling/behavior-sdk",
  "inkling/behavior-sdk",
]);

const FORBIDDEN_SOURCE = [
  ["network", /\b(fetch|XMLHttpRequest|WebSocket|EventSource)\b/],
  ["storage", /\b(localStorage|sessionStorage|indexedDB|caches)\b/],
  ["dom", /\b(document|window|navigator|HTMLElement)\b/],
  ["globals", /\b(globalThis|process|require|module|exports)\b/],
  ["dynamic_code", /\b(eval|Function)\s*\(/],
  ["wall_clock", /\b(Date|performance)\b/],
  ["unseeded_random", /\bMath\.random\s*\(/],
  ["timers", /\b(setTimeout|setInterval|setImmediate|queueMicrotask)\b/],
  ["dynamic_import", /\bimport\s*\(/],
] as const;

function sourceFromDiff(diff: string): string {
  const lines = diff.replaceAll("\r\n", "\n").split("\n");
  const added = lines
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));
  return added.length > 0 ? added.join("\n") : diff;
}

function validPath(path: string): boolean {
  if (path.startsWith("/") || path.includes("..") || path.includes("\\")) {
    return false;
  }
  return /(^|\/)behaviors\/[a-zA-Z0-9_.-]+\.(?:js|ts)$/.test(path);
}

function staticErrors(source: string, expectedEntityId: string): string[] {
  const errors: string[] = [];
  for (const match of source.matchAll(
    /^\s*import(?:[\s\S]*?)\sfrom\s+["']([^"']+)["'];?\s*$/gm,
  )) {
    const moduleName = match[1];
    if (!moduleName || !ALLOWED_IMPORTS.has(moduleName)) {
      errors.push(`forbidden_import:${moduleName ?? "unknown"}`);
    }
  }
  for (const [name, pattern] of FORBIDDEN_SOURCE) {
    if (pattern.test(source)) errors.push(`forbidden_${name}`);
  }
  if (!/\bdefineBehavior\s*\(/.test(source)) {
    errors.push("missing_defineBehavior");
  }
  if (!/\bonUpdate\s*[:(]/.test(source)) {
    errors.push("missing_onUpdate");
  }
  const literalId = source.match(/\bid\s*:\s*["']([^"']+)["']/)?.[1];
  if (literalId && literalId !== expectedEntityId) {
    errors.push(`entity_id_mismatch:${literalId}`);
  }
  return [...new Set(errors)];
}

function sandboxWorkerPath(): string {
  const candidates = [
    join(process.cwd(), "packages", "sdk", "src", "sandbox-worker.cjs"),
    join(process.cwd(), "dist", "packages", "sdk", "src", "sandbox-worker.cjs"),
  ];
  const found = candidates.find(existsSync);
  if (!found) throw new Error("sandbox worker not found");
  return found;
}

function runSandbox(source: string, expectedEntityId: string): Promise<string[]> {
  return new Promise((resolve) => {
    let worker: ReturnType<typeof spawn>;
    try {
      const path = sandboxWorkerPath();
      worker = spawn(
        process.execPath,
        ["--permission", `--allow-fs-read=${path}`, path],
        { env: {}, stdio: ["pipe", "pipe", "pipe"] },
      );
    } catch (error) {
      resolve([`sandbox_start:${String(error)}`]);
      return;
    }
    if (!worker.stdin || !worker.stdout || !worker.stderr) {
      worker.kill("SIGKILL");
      resolve(["sandbox_stdio_unavailable"]);
      return;
    }

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      worker.kill("SIGKILL");
      resolve(["sandbox_timeout"]);
    }, 2_000);
    timer.unref();

    worker.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    worker.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      resolve([`sandbox_error:${error.message}`]);
    });
    worker.once("close", (code) => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(stdout) as { valid: boolean; errors?: string[] };
        if (code === 0 && result.valid) resolve([]);
        else resolve(result.errors ?? [`sandbox_exit:${String(code)}`, stderr.trim()]);
      } catch {
        resolve([`sandbox_invalid_output:${stderr.trim() || stdout.trim()}`]);
      }
    });
    worker.stdin.end(JSON.stringify({ source, expectedEntityId, seed: 1337 }));
  });
}

/** Never throws: an invalid module always falls back to the static behavior. */
export async function validateBehaviorOperation(
  operation: Responses.ResponseApplyPatchToolCall["operation"],
  expectedEntityId: string,
): Promise<BehaviorValidation> {
  try {
    if (operation.type !== "create_file") {
      return {
        valid: false,
        fallback: "static",
        errors: ["only_create_file_allowed"],
      };
    }
    if (!validPath(operation.path)) {
      return {
        valid: false,
        fallback: "static",
        errors: [`invalid_behavior_path:${operation.path}`],
      };
    }
    const source = sourceFromDiff(operation.diff);
    const errors = staticErrors(source, expectedEntityId);
    if (errors.length > 0) return { valid: false, fallback: "static", errors };
    errors.push(...(await runSandbox(source, expectedEntityId)));
    if (errors.length > 0) return { valid: false, fallback: "static", errors };
    return {
      valid: true,
      fallback: "static",
      errors: [],
      patch: { entityId: expectedEntityId, operation, source },
    };
  } catch (error) {
    return {
      valid: false,
      fallback: "static",
      errors: [`validator_error:${String(error)}`],
    };
  }
}
