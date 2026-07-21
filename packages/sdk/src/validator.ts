import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Responses } from "openai/resources/responses/responses";

import type { BehaviorPatch } from "../../../runner/types.js";
import {
  isBehaviorMotionTrack,
  type BehaviorMotionTrack,
} from "../../../packages/runtime/src/behavior-track.js";

export interface BehaviorValidation {
  valid: boolean;
  fallback: "static";
  errors: string[];
  patch?: BehaviorPatch;
  /**
   * The bounded motion the module produced in the sandbox simulation. This
   * data — never the module source — is what the runtime executes.
   */
  track?: BehaviorMotionTrack;
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

/**
 * Removes `//` and `/* *​/` comments while leaving string and template
 * literal contents intact, so a comment can never trip the lexical layer.
 * The scanner is deliberately conservative: anything it cannot classify is
 * kept, and the VM sandbox — which always runs the ORIGINAL source — remains
 * the real enforcement boundary.
 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  type Mode = "code" | "single" | "double" | "template" | "line" | "block";
  const stack: Mode[] = ["code"];
  while (i < source.length) {
    const mode = stack[stack.length - 1]!;
    const char = source[i]!;
    const next = source[i + 1];
    if (mode === "line") {
      if (char === "\n") { stack.pop(); out += char; }
      i += 1;
      continue;
    }
    if (mode === "block") {
      if (char === "*" && next === "/") { stack.pop(); i += 2; continue; }
      if (char === "\n") out += char;
      i += 1;
      continue;
    }
    if (mode === "single" || mode === "double") {
      out += char;
      if (char === "\\" && next !== undefined) { out += next; i += 2; continue; }
      if ((mode === "single" && char === "'") || (mode === "double" && char === '"') || char === "\n") stack.pop();
      i += 1;
      continue;
    }
    if (mode === "template") {
      out += char;
      if (char === "\\" && next !== undefined) { out += next; i += 2; continue; }
      if (char === "`") { stack.pop(); i += 1; continue; }
      if (char === "$" && next === "{") { out += "{"; stack.push("code"); i += 2; continue; }
      i += 1;
      continue;
    }
    // mode === "code"
    if (char === "/" && next === "/") { stack.push("line"); i += 2; continue; }
    if (char === "/" && next === "*") { stack.push("block"); i += 2; continue; }
    if (char === "'") { stack.push("single"); out += char; i += 1; continue; }
    if (char === '"') { stack.push("double"); out += char; i += 1; continue; }
    if (char === "`") { stack.push("template"); out += char; i += 1; continue; }
    if (char === "{") { stack.push("code"); out += char; i += 1; continue; }
    if (char === "}" && stack.length > 1) { stack.pop(); out += char; i += 1; continue; }
    out += char;
    i += 1;
  }
  return out;
}

function validPath(path: string): boolean {
  if (path.startsWith("/") || path.includes("..") || path.includes("\\")) {
    return false;
  }
  return /(^|\/)behaviors\/[a-zA-Z0-9_.-]+\.(?:js|ts)$/.test(path);
}

function staticErrors(rawSource: string, expectedEntityId: string): string[] {
  // Lexical checks look only at executable text: a comment mentioning
  // `fetch` or `document` must never reject a legitimate module, while the
  // same token in real code still does.
  const source = stripComments(rawSource);
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
  // The entity-id binding is deliberately NOT checked lexically: modules
  // legitimately nest other id-like literals (state names, animation keys)
  // that no regex can distinguish from the registration. The sandbox is the
  // enforcement point — it runs the module and fails closed unless
  // behavior.id equals the expected entity, which a source string can't spoof.
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

interface SandboxOutcome {
  errors: string[];
  track?: BehaviorMotionTrack;
}

function runSandbox(source: string, expectedEntityId: string): Promise<SandboxOutcome> {
  return new Promise<SandboxOutcome>((resolve) => {
    let worker: ReturnType<typeof spawn>;
    try {
      const path = sandboxWorkerPath();
      worker = spawn(
        process.execPath,
        ["--permission", `--allow-fs-read=${path}`, path],
        { env: {}, stdio: ["pipe", "pipe", "pipe"] },
      );
    } catch (error) {
      resolve({ errors: [`sandbox_start:${String(error)}`] });
      return;
    }
    if (!worker.stdin || !worker.stdout || !worker.stderr) {
      worker.kill("SIGKILL");
      resolve({ errors: ["sandbox_stdio_unavailable"] });
      return;
    }

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      worker.kill("SIGKILL");
      resolve({ errors: ["sandbox_timeout"] });
    }, 4_000);
    timer.unref();

    worker.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    worker.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      resolve({ errors: [`sandbox_error:${error.message}`] });
    });
    worker.once("close", (code) => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(stdout) as {
          valid: boolean;
          errors?: string[];
          track?: unknown;
        };
        if (code === 0 && result.valid) {
          // The track is re-validated here even though the worker produced
          // it: defense in depth against a compromised or truncated worker
          // response ever shipping unbounded motion data.
          const track = isBehaviorMotionTrack(result.track) && result.track.entityId === expectedEntityId
            ? result.track
            : undefined;
          resolve(track ? { errors: [], track } : { errors: [] });
          return;
        }
        resolve({ errors: result.errors ?? [`sandbox_exit:${String(code)}`, stderr.trim()] });
      } catch {
        resolve({ errors: [`sandbox_invalid_output:${stderr.trim() || stdout.trim()}`] });
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
        // Model-facing feedback: state the accepted shape so the session
        // converges instead of probing path conventions round after round.
        errors: [
          `invalid_behavior_path:${operation.path}:must match behaviors/<name>.js or behaviors/<name>.ts with no directories`,
        ],
      };
    }
    const source = sourceFromDiff(operation.diff);
    const errors = staticErrors(source, expectedEntityId);
    if (errors.length > 0) return { valid: false, fallback: "static", errors };
    const sandbox = await runSandbox(source, expectedEntityId);
    if (sandbox.errors.length > 0) {
      return { valid: false, fallback: "static", errors: sandbox.errors };
    }
    return {
      valid: true,
      fallback: "static",
      errors: [],
      patch: { entityId: expectedEntityId, operation, source },
      ...(sandbox.track ? { track: sandbox.track } : {}),
    };
  } catch (error) {
    return {
      valid: false,
      fallback: "static",
      errors: [`validator_error:${String(error)}`],
    };
  }
}
