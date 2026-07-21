import {
  ModelCallError,
  ModelOutputError,
  PipelineBlocked,
  SolvabilityError,
} from "../../../runner/pipeline.js";
import type { GenerationMetrics, ScanResult } from "../../../runner/types.js";
import type { PlayableGameDocument } from "../../../packages/runtime/src/artwork.js";

/**
 * One generation's anonymous quality evidence for operator-side aggregation.
 * Deliberately excludes image data, drawing content, model output, session
 * ids, and safety identifiers so recording it never touches the no-retention
 * posture. Certification (real-browser replay) runs in the client, so a
 * server-side record can only say "not_measured".
 */
export interface GenerationQualityRecord {
  outcome: "playable" | "failed";
  failureCode?: string;
  /** Pipeline stage whose failure ended a failed generation, e.g. "P1". */
  failureStage?: string;
  /**
   * Enum-only failure class (transport_error, provider_5xx, provider_4xx,
   * deadline_exceeded, aborted, invalid_model_output, not_solvable,
   * call_failed, unclassified) or a schema-enum gate code prefixed
   * "blocked_". Never free text, never model output, never content.
   */
  failureReason?: string;
  /** True when the one bounded transport retry was spent before failing. */
  retryAttempted?: boolean;
  totalDurationMs: number;
  finalGenre?: string;
  playContractOutcome?: string;
  p8Iterations?: number;
  safetyRecast?: boolean;
  objectiveFallback?: boolean;
  recastRung?: string | null;
  degradedCount?: number;
  certification: "valid" | "invalid" | "not_measured";
  calls?: GenerationMetrics["calls"];
}

export function buildPlayableQualityRecord(
  scan: ScanResult,
  playableGame: PlayableGameDocument,
): GenerationQualityRecord {
  const playContractOutcome = playableGame.readinessEvidence?.playContract.outcome;
  return {
    outcome: "playable",
    totalDurationMs: scan.metrics.totalDurationMs,
    finalGenre: scan.metrics.finalGenre,
    p8Iterations: scan.metrics.p8Iterations,
    safetyRecast: scan.metrics.safetyRecast,
    objectiveFallback: scan.metrics.objectiveFallback,
    recastRung: scan.metrics.recastRung,
    degradedCount: scan.metrics.degradedCount,
    certification: "not_measured",
    calls: scan.metrics.calls,
    ...(playContractOutcome !== undefined ? { playContractOutcome } : {}),
  };
}

/** Gate reason codes are schema enums; anything else is refused as content. */
const ENUM_REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Derives the failing stage, an enum-only coded reason, and whether the one
 * bounded transport retry was spent — from the typed pipeline errors only.
 * Free-text messages are never copied into the record, so no model output or
 * drawing content can leak through this path.
 */
function describeFailureCause(
  cause: unknown,
): Pick<GenerationQualityRecord, "failureStage" | "failureReason" | "retryAttempted"> {
  if (cause instanceof PipelineBlocked) {
    const verdict = cause.verdict as Record<string, unknown> | null;
    const reasonCode = verdict !== null && typeof verdict === "object" &&
      typeof verdict.reason_code === "string" && ENUM_REASON_CODE.test(verdict.reason_code)
      ? `blocked_${verdict.reason_code}`
      : "blocked";
    return { failureStage: cause.callId, failureReason: reasonCode, retryAttempted: false };
  }
  if (cause instanceof ModelCallError) {
    return {
      failureStage: cause.callId,
      failureReason: cause.reason,
      retryAttempted: cause.retryAttempted,
    };
  }
  if (cause instanceof ModelOutputError) {
    return { failureStage: cause.callId, failureReason: "invalid_model_output", retryAttempted: false };
  }
  if (cause instanceof SolvabilityError) {
    return { failureStage: cause.callId, failureReason: "not_solvable", retryAttempted: false };
  }
  // Aborts propagate as the runner's own coded abort reasons, unwrapped.
  if (cause instanceof Error) {
    if (cause.message === "generation_deadline_exceeded") {
      return { failureReason: "deadline_exceeded", retryAttempted: false };
    }
    if (
      cause.name === "AbortError" ||
      cause.message === "client_disconnected" ||
      cause.message === "generation_stream_cancelled" ||
      cause.message === "generation_stream_closed"
    ) {
      return { failureReason: "aborted", retryAttempted: false };
    }
  }
  return { failureReason: "unclassified", retryAttempted: false };
}

export function buildFailedQualityRecord(
  failureCode: string,
  totalDurationMs: number,
  cause?: unknown,
): GenerationQualityRecord {
  return {
    outcome: "failed",
    failureCode,
    totalDurationMs,
    certification: "not_measured",
    ...describeFailureCause(cause),
  };
}

/** Nearest-rank percentile over an unsorted sample; 0 for an empty sample. */
export function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1));
  return sorted[rank] ?? 0;
}

export interface GenerationQualitySummary {
  total: number;
  playable: number;
  failed: number;
  failureCodes: Record<string, number>;
  playContractOutcomes: Record<string, number>;
  finalGenres: Record<string, number>;
  certification: Record<string, number>;
  recastRungs: Record<string, number>;
  safetyRecastRate: number;
  objectiveFallbackRate: number;
  p8IterationsMean: number;
  latencyMs: { p50: number; p90: number; max: number };
  callLatencyMs: Record<string, { count: number; p50: number; max: number }>;
}

function count(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

export function summarizeQualityRecords(
  records: GenerationQualityRecord[],
): GenerationQualitySummary {
  const failureCodes: Record<string, number> = {};
  const playContractOutcomes: Record<string, number> = {};
  const finalGenres: Record<string, number> = {};
  const certification: Record<string, number> = {};
  const recastRungs: Record<string, number> = {};
  const durations: number[] = [];
  const callDurations = new Map<string, number[]>();
  let playable = 0;
  let recasts = 0;
  let objectiveFallbacks = 0;
  let p8IterationsSum = 0;
  let p8Samples = 0;

  for (const record of records) {
    durations.push(record.totalDurationMs);
    count(certification, record.certification);
    if (record.outcome === "playable") {
      playable += 1;
      if (record.finalGenre) count(finalGenres, record.finalGenre);
      if (record.playContractOutcome) count(playContractOutcomes, record.playContractOutcome);
      if (record.safetyRecast) recasts += 1;
      if (record.objectiveFallback) objectiveFallbacks += 1;
      count(recastRungs, record.recastRung ?? "none");
      if (typeof record.p8Iterations === "number") {
        p8IterationsSum += record.p8Iterations;
        p8Samples += 1;
      }
    } else {
      count(failureCodes, record.failureCode ?? "unknown");
    }
    for (const call of record.calls ?? []) {
      const bucket = callDurations.get(call.callId) ?? [];
      bucket.push(call.durationMs);
      callDurations.set(call.callId, bucket);
    }
  }

  const callLatencyMs: GenerationQualitySummary["callLatencyMs"] = {};
  for (const [callId, values] of callDurations) {
    callLatencyMs[callId] = {
      count: values.length,
      p50: percentile(values, 0.5),
      max: Math.max(...values),
    };
  }
  return {
    total: records.length,
    playable,
    failed: records.length - playable,
    failureCodes,
    playContractOutcomes,
    finalGenres,
    certification,
    recastRungs,
    safetyRecastRate: playable === 0 ? 0 : recasts / playable,
    objectiveFallbackRate: playable === 0 ? 0 : objectiveFallbacks / playable,
    p8IterationsMean: p8Samples === 0 ? 0 : p8IterationsSum / p8Samples,
    latencyMs: {
      p50: percentile(durations, 0.5),
      p90: percentile(durations, 0.9),
      max: durations.length === 0 ? 0 : Math.max(...durations),
    },
    callLatencyMs,
  };
}
