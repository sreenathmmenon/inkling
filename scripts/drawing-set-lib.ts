import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { extname, join, sep } from "node:path";

import type { GenerationMetrics } from "../runner/types.js";
import {
  summarizeQualityRecords,
  type GenerationQualityRecord,
  type GenerationQualitySummary,
} from "../services/gen/src/quality-metrics.js";

export const SUPPORTED_IMAGE_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export interface DrawingFile {
  /** Path relative to the corpus root, using the platform separator. */
  path: string;
  hash: string;
}

export interface DrawingCaseResult {
  path: string;
  hash: string;
  status: "ready" | "failed";
  durationMs: number;
  genre?: string;
  goal?: string;
  reachedGoal?: boolean;
  playContractOutcome?: string;
  p8Iterations?: number;
  safetyRecast?: boolean;
  objectiveFallback?: boolean;
  recastRung?: string | null;
  /** Enum-only (role, behavior) pairs from the raw P2 extraction — no drawing content. */
  extractedBehaviors?: Array<{ role: string; behavior: string }>;
  /** Internal degrade trail, scrubbed of any image payloads. */
  degraded?: string[];
  /** Certified track evidence: entity id -> peak offset px. Content-free. */
  trackPeaks?: Record<string, number>;
  calls?: GenerationMetrics["calls"];
  error?: string;
  diagnostics?: { gameSpec?: unknown; solvabilityVerdicts: unknown[] };
  /** True when this result was carried over from a previous passing run. */
  reused?: boolean;
}

export interface DrawingSetReport {
  generatedAt: string;
  revision: string;
  seed?: number;
  sampled?: number;
  concurrency: number;
  results: DrawingCaseResult[];
  summary: GenerationQualitySummary;
}

/** Recursively lists supported images under root, numeric-sorted by path. */
export async function collectDrawingFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (SUPPORTED_IMAGE_TYPES[extname(entry.name).toLowerCase()] === undefined) continue;
    const parent = (entry as { parentPath?: string; path?: string }).parentPath
      ?? (entry as { path?: string }).path
      ?? root;
    const absolute = join(parent, entry.name);
    const relative = absolute.startsWith(root + sep)
      ? absolute.slice(root.length + 1)
      : absolute === root ? entry.name : absolute;
    files.push(relative);
  }
  return files.sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

export function contentHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Keeps the first occurrence (in the given order) of each distinct content
 * hash so repeated copies of one drawing are not counted twice.
 */
export function dedupeByContentHash(files: DrawingFile[]): {
  unique: DrawingFile[];
  duplicates: Array<{ path: string; duplicateOf: string }>;
} {
  const seen = new Map<string, string>();
  const unique: DrawingFile[] = [];
  const duplicates: Array<{ path: string; duplicateOf: string }> = [];
  for (const file of files) {
    const first = seen.get(file.hash);
    if (first === undefined) {
      seen.set(file.hash, file.path);
      unique.push(file);
    } else {
      duplicates.push({ path: file.path, duplicateOf: first });
    }
  }
  return { unique, duplicates };
}

/**
 * Deterministic seeded subset: files are ranked by the hash of `${seed}:path`
 * so the same seed always picks the same drawings regardless of run order,
 * then returned in their original order.
 */
export function sampleDeterministic(
  files: DrawingFile[],
  count: number,
  seed: number,
): DrawingFile[] {
  if (count >= files.length) return [...files];
  const rank = (file: DrawingFile): string =>
    createHash("sha256").update(`${seed}:${file.path}`).digest("hex");
  const chosen = new Set(
    [...files]
      .sort((left, right) => rank(left).localeCompare(rank(right)))
      .slice(0, Math.max(0, count))
      .map((file) => file.hash),
  );
  return files.filter((file) => chosen.has(file.hash));
}

/**
 * Splits a run into work and reusable results: a drawing whose content hash
 * already passed at the same revision is carried over instead of re-run, so a
 * repeat pass after a small fix is incremental. Failures always re-run.
 */
export function planRun(
  files: DrawingFile[],
  previous: DrawingSetReport | undefined,
  revision: string,
): { toRun: DrawingFile[]; reused: DrawingCaseResult[] } {
  if (!previous || previous.revision !== revision) {
    return { toRun: [...files], reused: [] };
  }
  const passing = new Map(
    previous.results
      .filter((result) => result.status === "ready")
      .map((result) => [result.hash, result]),
  );
  const toRun: DrawingFile[] = [];
  const reused: DrawingCaseResult[] = [];
  for (const file of files) {
    const prior = passing.get(file.hash);
    if (prior) {
      reused.push({ ...prior, path: file.path, reused: true });
    } else {
      toRun.push(file);
    }
  }
  return { toRun, reused };
}

export function caseToQualityRecord(result: DrawingCaseResult): GenerationQualityRecord {
  if (result.status === "ready") {
    const record: GenerationQualityRecord = {
      outcome: "playable",
      totalDurationMs: result.durationMs,
      certification: "not_measured",
    };
    if (result.genre !== undefined) record.finalGenre = result.genre;
    if (result.playContractOutcome !== undefined) record.playContractOutcome = result.playContractOutcome;
    if (result.p8Iterations !== undefined) record.p8Iterations = result.p8Iterations;
    if (result.safetyRecast !== undefined) record.safetyRecast = result.safetyRecast;
    if (result.objectiveFallback !== undefined) record.objectiveFallback = result.objectiveFallback;
    if (result.recastRung !== undefined) record.recastRung = result.recastRung;
    if (result.calls !== undefined) record.calls = result.calls;
    return record;
  }
  return {
    outcome: "failed",
    failureCode: result.error?.split(":")[0]?.trim().slice(0, 80) ?? "unknown",
    totalDurationMs: result.durationMs,
    certification: "not_measured",
  };
}

export function summarizeDrawingSetResults(
  results: DrawingCaseResult[],
): GenerationQualitySummary {
  return summarizeQualityRecords(results.map(caseToQualityRecord));
}
