import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import { generateDrawingGame } from "../services/gen/src/drawing-service.js";
import type { RequestTrace } from "../runner/types.js";
import {
  collectDrawingFiles,
  contentHash,
  dedupeByContentHash,
  planRun,
  sampleDeterministic,
  summarizeDrawingSetResults,
  SUPPORTED_IMAGE_TYPES,
  type DrawingCaseResult,
  type DrawingFile,
  type DrawingSetReport,
} from "./drawing-set-lib.js";

interface CliOptions {
  directory: string;
  output?: string;
  concurrency: number;
  sample?: number;
  seed: number;
  fresh: boolean;
}

function parseArguments(argv: string[]): CliOptions {
  const positional: string[] = [];
  const options: CliOptions = { directory: "", concurrency: 2, seed: 42, fresh: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === "--fresh") {
      options.fresh = true;
    } else if (argument === "--concurrency" || argument === "--sample" || argument === "--seed") {
      const value = Number(argv[index + 1]);
      index += 1;
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${argument} requires a positive integer`);
      }
      if (argument === "--concurrency") options.concurrency = value;
      if (argument === "--sample") options.sample = value;
      if (argument === "--seed") options.seed = value;
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown flag ${argument}`);
    } else {
      positional.push(argument);
    }
  }
  const directory = positional[0];
  if (!directory) {
    throw new Error(
      "Usage: npm run validate:drawing-set -- <drawing-directory> [report.json] " +
      "[--concurrency N] [--sample N] [--seed N] [--fresh]",
    );
  }
  options.directory = directory;
  const output = positional[1];
  if (output) options.output = output;
  return options;
}

function safeError(error: unknown): string {
  // This is a local test report. Keep it useful without putting image payloads,
  // keys, model output, or request headers into a user-visible file.
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/data:image\/[^\s]+/gi, "[image omitted]").slice(0, 500);
}

function buildRevision(): string {
  const declared = process.env.INKLING_BUILD_REVISION ?? process.env.RAILWAY_GIT_COMMIT_SHA;
  if (declared) return declared;
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function loadPreviousReport(path: string): Promise<DrawingSetReport | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as DrawingSetReport;
  } catch {
    return undefined;
  }
}

const cli = parseArguments(process.argv.slice(2));
if (!process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY is missing; add it to .env");
}

const directory = resolve(cli.directory);
const output = resolve(cli.output ?? `${directory}/validation-report.json`);
const revision = buildRevision();

const relativePaths = await collectDrawingFiles(directory);
if (relativePaths.length === 0) {
  throw new Error(
    `No supported images found under ${directory} (searched recursively; ` +
    `supported: ${Object.keys(SUPPORTED_IMAGE_TYPES).join(", ")})`,
  );
}

const hashed: DrawingFile[] = [];
for (const path of relativePaths) {
  hashed.push({ path, hash: contentHash(await readFile(resolve(directory, path))) });
}
const { unique, duplicates } = dedupeByContentHash(hashed);
for (const duplicate of duplicates) {
  process.stdout.write(`Skipping ${duplicate.path}: same drawing as ${duplicate.duplicateOf}\n`);
}

let selected = unique;
if (cli.sample !== undefined) {
  selected = sampleDeterministic(unique, cli.sample, cli.seed);
  process.stdout.write(`Sampled ${selected.length}/${unique.length} drawings (seed ${cli.seed})\n`);
}

const previous = cli.fresh ? undefined : await loadPreviousReport(output);
const { toRun, reused } = planRun(selected, previous, revision);
for (const carried of reused) {
  process.stdout.write(`Reusing passing result for ${carried.path} (revision ${revision})\n`);
}

const completed: DrawingCaseResult[] = [];
async function writeReport(): Promise<void> {
  const results = [...reused, ...completed]
    .sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true }));
  const report: DrawingSetReport = {
    generatedAt: new Date().toISOString(),
    revision,
    seed: cli.seed,
    concurrency: cli.concurrency,
    results,
    summary: summarizeDrawingSetResults(results),
    ...(cli.sample !== undefined ? { sampled: cli.sample } : {}),
  };
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
}

async function runCase(file: DrawingFile): Promise<DrawingCaseResult> {
  const mimeType = SUPPORTED_IMAGE_TYPES[extname(file.path).toLowerCase()] ?? "image/png";
  const bytes = await readFile(resolve(directory, file.path));
  const calls: RequestTrace[] = [];
  let extractedGameSpec: unknown;
  let extractedBehaviors: Array<{ role: string; behavior: string }> | undefined;
  const solvabilityVerdicts: unknown[] = [];
  process.stdout.write(`Scanning ${file.path}\n`);
  const startedAt = performance.now();
  try {
    const generated = await generateDrawingGame(
      {
        image: `data:${mimeType};base64,${bytes.toString("base64")}`,
        safetyId: createHash("sha256").update(`inkling-validation:${file.path}`).digest("hex"),
        context: { capture_surface: "paper", validation: "local" },
      },
      {
        onRequest: (trace) => calls.push(trace),
        onResult(callId, result) {
          if (callId === "P2" || callId === "P2_photo") {
            extractedGameSpec = result;
            const entities = (result as { entities?: Array<{ role?: unknown; behavior?: unknown }> }).entities;
            if (Array.isArray(entities)) {
              // Enum values only — never ids, names, styles, or coordinates.
              extractedBehaviors = entities.map((entity) => ({
                role: String(entity.role ?? "unknown"),
                behavior: String(entity.behavior ?? "unknown"),
              }));
            }
          }
          if (callId === "P8") solvabilityVerdicts.push(result);
        },
      },
    );
    const metrics = generated.scan.metrics;
    const playContractOutcome = generated.playableGame.readinessEvidence?.playContract.outcome;
    return {
      path: file.path,
      hash: file.hash,
      status: "ready",
      durationMs: Math.round(performance.now() - startedAt),
      genre: generated.scan.gameSpec.primary_genre,
      goal: generated.scan.gameSpec.goal.kind,
      reachedGoal: generated.scan.playtestReport.reached_goal,
      p8Iterations: metrics.p8Iterations,
      safetyRecast: metrics.safetyRecast,
      objectiveFallback: metrics.objectiveFallback,
      recastRung: metrics.recastRung,
      calls: metrics.calls,
      degraded: generated.scan.degraded.map(safeError),
      ...(extractedBehaviors !== undefined ? { extractedBehaviors } : {}),
      ...(playContractOutcome !== undefined ? { playContractOutcome } : {}),
    };
  } catch (error) {
    return {
      path: file.path,
      hash: file.hash,
      status: "failed",
      durationMs: Math.round(performance.now() - startedAt),
      calls: calls.map((trace) => ({
        callId: trace.callId,
        callName: trace.callName,
        model: trace.model,
        effort: trace.effort,
        attempt: trace.attempt,
        durationMs: 0,
      })),
      error: safeError(error),
      diagnostics: { gameSpec: extractedGameSpec, solvabilityVerdicts },
    };
  }
}

// A tiny worker pool: each generation is request-isolated, and results are
// re-sorted before every write so aggregation is order-independent.
const queue = [...toRun];
async function worker(): Promise<void> {
  while (true) {
    const next = queue.shift();
    if (!next) return;
    completed.push(await runCase(next));
    await writeReport();
  }
}
await Promise.all(
  Array.from({ length: Math.min(cli.concurrency, Math.max(queue.length, 1)) }, () => worker()),
);
await writeReport();

const results = [...reused, ...completed];
const passed = results.filter((result) => result.status === "ready").length;
const summary = summarizeDrawingSetResults(results);
console.log(`Validation complete: ${passed}/${results.length} ready (${reused.length} reused)`);
console.log(
  `Recast rate: ${(summary.safetyRecastRate * 100).toFixed(0)}%  ` +
  `contract outcomes: ${JSON.stringify(summary.playContractOutcomes)}  ` +
  `latency p50/p90/max: ${Math.round(summary.latencyMs.p50)}/${Math.round(summary.latencyMs.p90)}/${Math.round(summary.latencyMs.max)}ms`,
);
console.log(`Report: ${output}`);
if (passed !== results.length) process.exitCode = 1;
