import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import { generateDrawingGame } from "../services/gen/src/drawing-service.js";
import type { RequestTrace } from "../runner/types.js";

const inputDirectory = process.argv[2];
const outputArgument = process.argv[3];

if (!inputDirectory) {
  throw new Error("Usage: npm run validate:drawing-set -- <drawing-directory> [report.json]");
}
if (!process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY is missing; add it to .env");
}

const mimeTypes: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

type ValidationResult = {
  file: string;
  status: "ready" | "failed";
  genre?: string;
  goal?: string;
  reachedGoal?: boolean;
  calls: Array<Pick<RequestTrace, "callId" | "model" | "effort">>;
  error?: string;
  diagnostics?: {
    gameSpec?: unknown;
    solvabilityVerdicts: unknown[];
  };
};

function safeError(error: unknown): string {
  // This is a local test report. Keep it useful without putting image payloads,
  // keys, model output, or request headers into a user-visible file.
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/data:image\/[^\s]+/gi, "[image omitted]").slice(0, 500);
}

const directory = resolve(inputDirectory);
const output = resolve(outputArgument ?? `${directory}/validation-report.json`);
const files = (await readdir(directory))
  .filter((file) => mimeTypes[extname(file).toLowerCase()] !== undefined)
  .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

if (files.length === 0) throw new Error("No supported images found in drawing directory");

const results: ValidationResult[] = [];
for (const file of files) {
  const mimeType = mimeTypes[extname(file).toLowerCase()];
  if (!mimeType) continue;
  const bytes = await readFile(resolve(directory, file));
  const calls: RequestTrace[] = [];
  let extractedGameSpec: unknown;
  const solvabilityVerdicts: unknown[] = [];
  process.stdout.write(`Scanning ${file}\n`);
  try {
    const generated = await generateDrawingGame(
      {
        image: `data:${mimeType};base64,${bytes.toString("base64")}`,
        safetyId: createHash("sha256").update(`inkling-validation:${file}`).digest("hex"),
        context: { capture_surface: "paper", validation: "local" },
      },
      {
        onRequest: (trace) => calls.push(trace),
        onResult(callId, result) {
          if (callId === "P2" || callId === "P2_photo") extractedGameSpec = result;
          if (callId === "P8") solvabilityVerdicts.push(result);
        },
      },
    );
    results.push({
      file,
      status: "ready",
      genre: generated.scan.gameSpec.primary_genre,
      goal: generated.scan.gameSpec.goal.kind,
      reachedGoal: generated.scan.playtestReport.reached_goal,
      calls: calls.map(({ callId, model, effort }) => ({ callId, model, effort })),
    });
  } catch (error) {
    results.push({
      file,
      status: "failed",
      calls: calls.map(({ callId, model, effort }) => ({ callId, model, effort })),
      error: safeError(error),
      diagnostics: {
        gameSpec: extractedGameSpec,
        solvabilityVerdicts,
      },
    });
  }
  await writeFile(output, `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`);
}

const passed = results.filter((result) => result.status === "ready").length;
console.log(`Validation complete: ${passed}/${results.length} ready`);
console.log(`Report: ${output}`);
if (passed !== results.length) process.exitCode = 1;
