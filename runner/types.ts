import type { Responses } from "openai/resources/responses/responses";

export type JsonObject = Record<string, unknown>;
export type PipelineContext = Record<string, unknown>;

export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface SchemaDocument {
  name: string;
  schema: JsonObject;
  strict: true;
}

export interface PipelineCall {
  id: string;
  name: string;
  model: string;
  effort: ReasoningEffort;
  escalate_to?: ReasoningEffort;
  lane: string;
  input: string[];
  prompt: string;
  schema?: string;
  fewshot?: string;
  tools?: Array<"apply_patch" | "shell">;
  validator?: string;
  depends_on: string[];
  blocks_pipeline_on?: Record<string, unknown>;
  parallel_group: string | null;
  optional?: boolean;
  run_if?: string;
  loop_until?: string;
  max_iterations?: number;
  fan_out_over?: string;
  then?: string;
  hard_requires?: string[];
  effort_router?: {
    call: string;
    simple: ReasoningEffort;
    rich: ReasoningEffort;
  };
}

export interface PipelineSpec {
  version: string;
  api: "responses";
  globals: {
    reasoning_mode_live: string;
    reasoning_mode_offline: string;
    text_verbosity_json: "low" | "medium" | "high";
    /** Per-model-alias overrides for APIs that reject the global verbosity. */
    text_verbosity_by_model?: Record<string, "low" | "medium" | "high">;
    /**
     * Per-model-alias deterministic sampling. The Responses API accepts
     * temperature and top_p (there is no seed parameter on this surface);
     * declaring them here pins every request for that model to the exact
     * declared values — undeclared sampling on a request is rejected.
     */
    sampling_by_model?: Record<string, { temperature?: number; top_p?: number }>;
    safety_identifier: string;
  };
  models: Record<string, string>;
  calls: PipelineCall[];
  execution_graph: {
    scan_path: Array<string | { parallel: string }>;
    notes: string;
  };
}

export interface ResponseLike {
  id: string;
  output_text?: string;
  output: Array<Responses.ResponseOutputItem>;
}

export interface ResponsesClient {
  responses: {
    create(
      request: Responses.ResponseCreateParamsNonStreaming,
      options?: { signal?: AbortSignal },
    ): Promise<ResponseLike>;
  };
}

export interface RequestTrace {
  callId: string;
  callName: string;
  model: string;
  effort: ReasoningEffort;
  attempt: number;
  safetyIdentifier: string;
}

export interface RunnerOptions {
  safetyId: string;
  signal?: AbortSignal;
  offline?: boolean;
  client?: ResponsesClient;
  dryRun?: boolean;
  /**
   * Backoff before the single transport-class retry of a model call, in
   * milliseconds. Infrastructure knob only (tests, deployments); it never
   * changes which failures are retried. Defaults to 2s.
   */
  transportRetryBackoffMs?: number;
  onRequest?: (
    trace: RequestTrace,
    request: Responses.ResponseCreateParamsNonStreaming,
  ) => void;
  /** Local/server observability hook for validated structured results. */
  onResult?: (callId: string, result: unknown) => void;
}

export interface BoundingEntity {
  id: string;
  role: string;
  bbox: [number, number, number, number];
  behavior: string;
  style_ref: string;
  linked_to?: string | null;
}

export interface GameSpec {
  primary_genre: string;
  genre_confidence: number;
  mood?: string | null;
  hero: {
    id: string;
    name: string;
    bbox: [number, number, number, number];
    style_ref: string;
  };
  entities: BoundingEntity[];
  goal: { kind: string; target_id?: string | null };
  rules: {
    lives: number;
    difficulty_hint: string;
    modifiers?: string[] | null;
  };
  palette: string[];
  assumptions: string[];
  flags: string[];
}

export interface PlaytestReport {
  reached_goal: boolean;
  first_blocker: string | null;
  time_to_win: number | null;
  seed: number;
  visited: string[];
}

export interface BehaviorPatch {
  entityId: string;
  operation: Responses.ResponseApplyPatchToolCall["operation"];
  source: string;
}

/** One model call's routing and latency. Carries no content and no identity. */
export interface CallMetric {
  callId: string;
  callName: string;
  model: string;
  effort: ReasoningEffort;
  attempt: number;
  durationMs: number;
}

/**
 * Anonymous per-generation quality evidence. Deliberately excludes image
 * data, drawing content, model output, and any user identifier so it can be
 * aggregated and logged without touching the no-retention posture.
 */
export interface GenerationMetrics {
  totalDurationMs: number;
  calls: CallMetric[];
  p8Iterations: number;
  safetyRecast: boolean;
  objectiveFallback: boolean;
  /** Which recast-ladder rung was adopted, or null when the world survived unchanged. */
  recastRung: string | null;
  finalGenre: string;
  degradedCount: number;
}

export interface ScanResult {
  gameSpec: GameSpec;
  assets: Record<string, unknown>;
  behaviorPatches: BehaviorPatch[];
  behaviorFallbacks: Record<string, "static">;
  /** Certified sandbox motion per entity — the data the runtime executes. */
  behaviorTracks: Record<string, import("../packages/runtime/src/behavior-track.js").BehaviorMotionTrack>;
  playtestReport: PlaytestReport;
  solvability: JsonObject;
  calls: RequestTrace[];
  degraded: string[];
  metrics: GenerationMetrics;
  /**
   * The ordered genre decision's already-computed runner-up, when it genuinely
   * differs from the final certified genre. Null means the genre reading was
   * unanimous and no honest alternate exists to offer.
   */
  alternateGenre?: string | null;
}
