import OpenAI from "openai";
import type { Responses } from "openai/resources/responses/responses";

import { validateBehaviorOperation } from "../packages/sdk/src/validator.js";
import {
  TRACK_ANIMATABLE_ROLES,
  type BehaviorMotionTrack,
} from "../packages/runtime/src/behavior-track.js";
import {
  applyBoundedRepairs,
  runPlaytest,
} from "../services/solve/src/playtest.js";
import {
  buildRungCandidate,
  createDeterministicSafetyRecast,
  pruneBehaviorPatchesForWorld,
  RECAST_RUNG_ORDER,
  type RecastRung,
} from "./recast-ladder.js";

export { createDeterministicSafetyRecast } from "./recast-ladder.js";
import {
  callMap,
  findProjectRoot,
  loadJson,
  loadPipelineSpec,
  loadSchema,
  loadText,
} from "./spec.js";
import { validateJsonSchema } from "./schema-validation.js";
import type {
  BehaviorPatch,
  CallMetric,
  GameSpec,
  GenerationMetrics,
  JsonObject,
  PipelineCall,
  PipelineContext,
  PipelineSpec,
  PlaytestReport,
  RequestTrace,
  ResponseLike,
  ResponsesClient,
  RunnerOptions,
  ScanResult,
} from "./types.js";

interface ExecutionState extends PipelineContext {
  results: Record<string, unknown>;
  gamespec?: GameSpec;
  playtest_report?: PlaytestReport;
}

interface CallOverride {
  effort?: PipelineCall["effort"];
  input?: Responses.ResponseInput;
  modelAlias?: string;
}

const DYNAMIC_BEHAVIORS = new Set([
  "patrol",
  "chase",
  "spinner",
  "shooter",
  "faller",
  "rise",
]);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPath(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    return isRecord(value) ? value[key] : undefined;
  }, source);
}

function expressionIsTrue(expression: string | undefined, scope: unknown): boolean {
  if (!expression) return true;
  const includes = expression.match(/^([\w.]+)\s+includes\s+["']([^"']+)["']$/);
  if (includes) {
    const value = getPath(scope, includes[1] ?? "");
    return Array.isArray(value) && value.includes(includes[2]);
  }
  if (/^[\w.]+$/.test(expression)) {
    return Boolean(getPath(scope, expression));
  }
  const equality = expression.match(/^([\w.]+)\s*(==|!=)\s*["']?([^"']+?)["']?$/);
  if (!equality) throw new Error(`Unsupported spec expression: ${expression}`);
  const value = getPath(scope, equality[1] ?? "");
  const matches = String(value) === equality[3];
  return equality[2] === "!=" ? !matches : matches;
}

/**
 * Evaluates a declared blocks_pipeline_on rule against a gate result. A rule
 * value of {"not": x} blocks whenever the field differs from x, so unknown
 * verdict vocabulary fails closed; arrays block on any listed value. A result
 * that is not an object always blocks.
 */
function gateBlocks(rule: Record<string, unknown> | undefined, result: unknown): boolean {
  if (!rule) return false;
  if (!isRecord(result)) return true;
  for (const [field, expected] of Object.entries(rule)) {
    const value = result[field];
    if (Array.isArray(expected)) {
      if (expected.some((candidate) => candidate === value)) return true;
    } else if (isRecord(expected) && "not" in expected) {
      if (value !== expected.not) return true;
    } else if (value === expected) {
      return true;
    }
  }
  return false;
}

/**
 * Behavior validators the spec may name. Only registered validators run; an
 * unknown or missing declaration refuses the patch session outright, which
 * degrades the entity to static — never an unvalidated module.
 */
const BEHAVIOR_VALIDATORS: Record<string, typeof validateBehaviorOperation> = {
  headless_sdk_validator: validateBehaviorOperation,
};

function fallbackGameSpec(): GameSpec {
  return {
    primary_genre: "runner",
    genre_confidence: 0,
    hero: {
      id: "hero_1",
      name: "Hero",
      bbox: [0.08, 0.55, 0.2, 0.78],
      style_ref: "source-scan",
    },
    entities: [
      {
        id: "goal_1",
        role: "goal",
        bbox: [0.72, 0.55, 0.88, 0.78],
        behavior: "static",
        style_ref: "source-scan",
      },
    ],
    goal: { kind: "reach_goal", target_id: "goal_1" },
    rules: { lives: 3, difficulty_hint: "chill", modifiers: [] },
    palette: ["source-page"],
    assumptions: ["The safe fallback keeps the scanned art playable."],
    flags: ["deterministic_fallback"],
  };
}

export function isGameSpec(value: unknown): value is GameSpec {
  if (!isRecord(value)) return false;
  return (
    typeof value.primary_genre === "string" &&
    isRecord(value.hero) &&
    typeof value.hero.id === "string" &&
    Array.isArray(value.hero.bbox) &&
    Array.isArray(value.entities) &&
    isRecord(value.goal) &&
    isRecord(value.rules) &&
    Array.isArray(value.palette) &&
    Array.isArray(value.assumptions) &&
    Array.isArray(value.flags)
  );
}

function dryRunGameSpec(): GameSpec {
  return {
    primary_genre: "platformer",
    genre_confidence: 0.4,
    mood: "cheerful",
    hero: {
      id: "hero_1",
      name: "Dry Run Hero",
      bbox: [0.05, 0.55, 0.15, 0.75],
      style_ref: "source-strokes",
    },
    entities: [
      {
        id: "walker_1",
        role: "enemy",
        bbox: [0.15, 0.2, 0.28, 0.34],
        behavior: "patrol",
        linked_to: null,
        style_ref: "source-strokes",
      },
      {
        id: "goal_1",
        role: "goal",
        bbox: [0.31, 0.5, 0.45, 0.7],
        behavior: "static",
        linked_to: null,
        style_ref: "source-strokes",
      },
    ],
    goal: { kind: "reach_goal", target_id: "goal_1" },
    rules: { lives: 3, difficulty_hint: "normal", modifiers: [] },
    palette: ["#000000"],
    assumptions: [],
    flags: ["genre_uncertain"],
  };
}

function dryRunOutput(callId: string): unknown {
  switch (callId) {
    case "P1":
      return { verdict: "allow", reason_code: "none" };
    case "P0_calibrate":
      return { complexity: "rich" };
    case "P2":
    case "P2_photo":
    case "P10":
      return dryRunGameSpec();
    case "P3":
      return {
        topology: "blob",
        tier: "squash_stretch_puppet",
        joints: [],
        animations: ["idle"],
        style_ref: null,
      };
    case "P4":
      return { layers: [{ source: "source-page", parallax: 0.5 }] };
    case "P5":
      return { music_pack_id: "base", sfx_pack_id: "base" };
    case "P6":
      return { primary_genre: "platformer", alt_genre: "runner", rationale_for_log: "dry-run" };
    case "P7":
      return { patches: [], manifest: "dry-run" };
    case "P8":
      return { verdict: "ready", repairs: [], fallback: "none" };
    case "P9":
      return { spec_diff_json: "{}", needs_code: false, patch: null };
    case "P11":
      return { publishable: true, reason_code: "none" };
    default:
      return {};
  }
}

function outputText(response: ResponseLike): string {
  if (response.output_text) return response.output_text;
  for (const item of response.output) {
    if (item.type !== "message") continue;
    for (const content of item.content) {
      if (content.type === "output_text") return content.text;
    }
  }
  return "";
}

function parseStructured(response: ResponseLike, call: PipelineCall): unknown {
  const text = outputText(response);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ModelOutputError(call.id, `invalid structured output: ${String(error)}`);
  }
}

function parseEditDiffJson(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || typeof value.spec_diff_json !== "string") {
    throw new ModelOutputError("P9", "missing serialized spec_diff_json");
  }
  let specDiff: unknown;
  try {
    specDiff = JSON.parse(value.spec_diff_json) as unknown;
  } catch (error) {
    throw new ModelOutputError("P9", `invalid spec_diff_json: ${String(error)}`);
  }
  if (!isRecord(specDiff)) {
    throw new ModelOutputError("P9", "spec_diff_json must decode to an object");
  }
  const { spec_diff_json: _serialized, ...rest } = value;
  return { ...rest, spec_diff: specDiff };
}

function normalizeNullableGameSpec(gameSpec: GameSpec): GameSpec {
  for (const entity of gameSpec.entities) {
    if (entity.linked_to === null) delete entity.linked_to;
  }
  if (gameSpec.goal.target_id === null) delete gameSpec.goal.target_id;
  if (gameSpec.rules.modifiers === null) delete gameSpec.rules.modifiers;
  return gameSpec;
}

function mapTool(tool: "apply_patch" | "shell"): Responses.Tool {
  if (tool === "shell") {
    return {
      type: "shell",
      environment: {
        type: "container_auto",
        network_policy: { type: "disabled" },
      },
    };
  }
  return { type: "apply_patch" };
}

export function assertRequestMatchesSpec(
  spec: PipelineSpec,
  call: PipelineCall,
  request: Responses.ResponseCreateParamsNonStreaming,
  modelAlias = call.model,
): void {
  const expectedModel = spec.models[modelAlias];
  if (!expectedModel || request.model !== expectedModel) {
    throw new Error(`${call.id} model mismatch: ${String(request.model)} != ${String(expectedModel)}`);
  }
  const effort = request.reasoning?.effort;
  const allowedEfforts = new Set<unknown>([
    call.effort,
    call.escalate_to,
    call.effort_router?.simple,
    call.effort_router?.rich,
  ]);
  if (!allowedEfforts.has(effort)) {
    throw new Error(`${call.id} effort ${String(effort)} is not declared in pipeline.json`);
  }
  if (!request.safety_identifier) {
    throw new Error(`${call.id} is missing safety_identifier`);
  }
  // Fail loudly (also in dry-run) when a request carries a verbosity the
  // spec does not declare for its model, instead of silently 400ing in
  // production the way the launch P7 sessions did.
  const expectedVerbosity = spec.globals.text_verbosity_by_model?.[modelAlias]
    ?? spec.globals.text_verbosity_json;
  if (request.text?.verbosity !== expectedVerbosity) {
    throw new Error(
      `${call.id} verbosity ${String(request.text?.verbosity)} does not match the declared ${expectedVerbosity} for ${modelAlias}`,
    );
  }
  if (call.schema) {
    const format = request.text?.format;
    if (!format || format.type !== "json_schema" || format.strict !== true) {
      throw new Error(`${call.id} is missing strict structured output`);
    }
  }
}

class PipelineRunner {
  readonly root = findProjectRoot();
  readonly spec = loadPipelineSpec(this.root);
  readonly callsById = callMap(this.spec);
  readonly traces: RequestTrace[] = [];
  readonly degraded: string[] = [];
  readonly callMetrics: CallMetric[] = [];
  private client: ResponsesClient | undefined;
  private attempts = new Map<string, number>();
  /**
   * Shared behavior-session budget per scan. Uncapped agentic sessions can
   * exceed the production generation deadline (observed: 98 P7 calls,
   * 13.5 minutes against an 8-minute deadline), which fails the whole scan;
   * a bounded budget degrades stragglers to static instead.
   */
  private behaviorCallBudget = 24;

  constructor(private readonly options: RunnerOptions) {
    if (!options.safetyId || options.safetyId.length > 64) {
      throw new Error("safetyId must be a non-empty privacy-preserving hash of at most 64 characters");
    }
    this.client = options.client;
  }

  call(id: string): PipelineCall {
    const call = this.callsById.get(id);
    if (!call) throw new Error(`Unknown pipeline call ${id}`);
    return call;
  }

  private resolveInputs(call: PipelineCall, state: ExecutionState): PipelineContext {
    const inputs: PipelineContext = {};
    for (const input of call.input) {
      const optional = input.endsWith("?");
      const path = optional ? input.slice(0, -1) : input;
      const value = getPath(state, path);
      if (value === undefined && !optional) {
        throw new Error(`${call.id} missing required input ${path}`);
      }
      if (value !== undefined) inputs[path] = value;
    }
    return inputs;
  }

  private buildInput(
    call: PipelineCall,
    state: ExecutionState,
    extra: PipelineContext = {},
  ): Responses.ResponseInput {
    const variables = { ...this.resolveInputs(call, state), ...extra };
    const content: Responses.ResponseInputContent[] = [];
    for (const key of ["image", "photo", "image_new"] as const) {
      const value = variables[key];
      if (typeof value === "string") {
        content.push({ type: "input_image", image_url: value, detail: "high" });
        delete variables[key];
      }
    }
    content.push({ type: "input_text", text: JSON.stringify(variables) });

    const messages: Responses.ResponseInput = [];
    if (call.fewshot) {
      const fewshot = loadJson<Responses.ResponseInput>(this.root, call.fewshot);
      messages.push(...fewshot);
    }
    messages.push({ role: "user", content });
    return messages;
  }

  private effortFor(call: PipelineCall, state: ExecutionState): PipelineCall["effort"] {
    if (!call.effort_router) return call.effort;
    const route = state.results[call.effort_router.call];
    const complexity = isRecord(route) ? route.complexity : undefined;
    return complexity === "simple"
      ? call.effort_router.simple
      : complexity === "rich"
        ? call.effort_router.rich
        : call.effort;
  }

  private buildRequest(
    call: PipelineCall,
    state: ExecutionState,
    override: CallOverride = {},
  ): Responses.ResponseCreateParamsNonStreaming {
    const schema = loadSchema(this.root, call);
    const modelAlias = override.modelAlias ?? call.model;
    const model = this.spec.models[modelAlias];
    if (!model) throw new Error(`${call.id} references unknown model alias ${modelAlias}`);
    const request: Responses.ResponseCreateParamsNonStreaming = {
      model,
      instructions: loadText(this.root, call.prompt),
      input: override.input ?? this.buildInput(call, state),
      reasoning: {
        effort: override.effort ?? this.effortFor(call, state),
        mode: this.options.offline
          ? this.spec.globals.reasoning_mode_offline
          : this.spec.globals.reasoning_mode_live,
      },
      // Verbosity is per-model: some models reject the global default (the
      // codex API only accepts medium), and a wrong value fails the whole
      // call with a 400 before any work happens.
      text: {
        verbosity: this.spec.globals.text_verbosity_by_model?.[modelAlias]
          ?? this.spec.globals.text_verbosity_json,
      },
      safety_identifier: this.options.safetyId,
      store: false,
    };
    if (schema) {
      request.text = {
        ...request.text,
        format: {
          type: "json_schema",
          name: schema.name,
          schema: schema.schema,
          strict: true,
        },
      };
    }
    if (call.tools) request.tools = call.tools.map(mapTool);
    return request;
  }

  private async send(
    call: PipelineCall,
    request: Responses.ResponseCreateParamsNonStreaming,
    modelAlias = call.model,
  ): Promise<ResponseLike> {
    assertRequestMatchesSpec(this.spec, call, request, modelAlias);
    const attempt = (this.attempts.get(call.id) ?? 0) + 1;
    this.attempts.set(call.id, attempt);
    const effort = request.reasoning?.effort;
    if (!effort) throw new Error(`${call.id} missing reasoning effort`);
    const trace: RequestTrace = {
      callId: call.id,
      callName: call.name,
      model: String(request.model),
      effort,
      attempt,
      safetyIdentifier: request.safety_identifier ?? "",
    };
    this.traces.push(trace);
    this.options.onRequest?.(trace, request);

    const startedAt = performance.now();
    try {
      if (this.options.dryRun) {
        return {
          id: `dry-${call.id}-${attempt}`,
          output_text: JSON.stringify(dryRunOutput(call.id)),
          output: [],
        };
      }
      if (!this.client) this.client = new OpenAI() as unknown as ResponsesClient;
      this.options.signal?.throwIfAborted();
      return await this.client.responses.create(
        request,
        this.options.signal ? { signal: this.options.signal } : undefined,
      );
    } finally {
      this.callMetrics.push({
        callId: call.id,
        callName: call.name,
        model: String(request.model),
        effort,
        attempt,
        durationMs: performance.now() - startedAt,
      });
    }
  }

  private validateStructuredResult(call: PipelineCall, result: unknown): void {
    const document = loadSchema(this.root, call);
    if (!document) return;
    const issues = validateJsonSchema(result, document.schema);
    if (issues.length > 0) {
      const summary = issues
        .slice(0, 3)
        .map((issue) => `${issue.path} ${issue.message}`)
        .join("; ");
      throw new ModelOutputError(call.id, `response does not match ${document.name}: ${summary}`);
    }
  }

  async structured(call: PipelineCall, state: ExecutionState): Promise<unknown> {
    if (!expressionIsTrue(call.run_if, state)) return null;
    let request = this.buildRequest(call, state);
    let response = await this.send(call, request);
    let result = parseStructured(response, call);
    this.validateStructuredResult(call, result);
    this.options.onResult?.(call.id, clone(result));
    if (
      call.escalate_to &&
      isRecord(result) &&
      result.verdict === "uncertain"
    ) {
      request = this.buildRequest(call, state, { effort: call.escalate_to });
      response = await this.send(call, request);
      result = parseStructured(response, call);
      this.validateStructuredResult(call, result);
    }
    return result;
  }

  async behavior(
    call: PipelineCall,
    state: ExecutionState,
    entity: GameSpec["entities"][number],
    modelAlias = call.model,
  ): Promise<{ patches: BehaviorPatch[]; fallback: boolean; tracks: BehaviorMotionTrack[] }> {
    const validatorName = call.validator;
    if (!validatorName) {
      throw new Error(`${call.id} produces behavior patches but declares no validator`);
    }
    const validate = BEHAVIOR_VALIDATORS[validatorName];
    if (!validate) {
      throw new Error(`${call.id} declares unknown validator ${validatorName}`);
    }

    const takeBudget = (): boolean => {
      if (this.behaviorCallBudget <= 0) return false;
      this.behaviorCallBudget -= 1;
      return true;
    };

    const attempt = async (
      effort?: PipelineCall["effort"],
    ): Promise<{ patches: BehaviorPatch[]; fallback: boolean; tracks: BehaviorMotionTrack[] }> => {
      if (!takeBudget()) {
        this.degraded.push(`${call.id}:${entity.id}:behavior_budget_exhausted`);
        return { patches: [], fallback: true, tracks: [] };
      }
      const request = this.buildRequest(call, state, {
        input: this.buildInput(call, state, { item: entity }),
        modelAlias,
        ...(effort ? { effort } : {}),
      });
      let response = await this.send(call, request, modelAlias);
      if (this.options.dryRun) return { patches: [], fallback: false, tracks: [] };

      const patches: BehaviorPatch[] = [];
      const tracks: BehaviorMotionTrack[] = [];
      for (let round = 0; round < 6; round += 1) {
        const patchCalls = response.output.filter(
          (item): item is Responses.ResponseApplyPatchToolCall =>
            item.type === "apply_patch_call",
        );
        if (patchCalls.length === 0) {
          return { patches, fallback: patches.length === 0, tracks };
        }
        if (!takeBudget()) {
          this.degraded.push(`${call.id}:${entity.id}:behavior_budget_exhausted`);
          return { patches, fallback: patches.length === 0, tracks };
        }
        const outputs: Responses.ResponseInput = [];
        for (const patchCall of patchCalls) {
          const validation = await validate(patchCall.operation, entity.id);
          if (validation.valid && validation.patch) {
            patches.push(validation.patch);
            if (validation.track) tracks.push(validation.track);
          } else {
            // Rejections are operator evidence: without this trail a
            // systematically failing validator looks identical to a model
            // that never proposed anything.
            this.degraded.push(
              `${call.id}:${entity.id}:patch_rejected:${validation.errors[0] ?? "unknown"}`,
            );
          }
          outputs.push({
            type: "apply_patch_call_output",
            call_id: patchCall.call_id,
            status: validation.valid ? "completed" : "failed",
            output: validation.valid ? `${validatorName}:passed` : validation.errors.join(","),
          });
        }
        const continuation = this.buildRequest(call, state, {
          input: [...response.output, ...outputs] as Responses.ResponseInput,
          modelAlias,
          ...(effort ? { effort } : {}),
        });
        response = await this.send(call, continuation, modelAlias);
      }
      // Round exhaustion keeps what already passed the full sandbox: every
      // collected patch was independently validated and certified, so a
      // model that never says "done" cannot void its own accepted work.
      return { patches, fallback: patches.length === 0, tracks };
    };

    // A thrown session (transport failure, rejected request) follows the
    // same declared escalation a fruitless one does — the launch P7 bug hid
    // behind errors bypassing this path entirely.
    let outcome: { patches: BehaviorPatch[]; fallback: boolean; tracks: BehaviorMotionTrack[] };
    try {
      outcome = await attempt();
    } catch (error) {
      if (!call.escalate_to) throw error;
      this.degraded.push(`${call.id}:${entity.id}:first_attempt:${String(error)}`);
      return attempt(call.escalate_to);
    }
    if (outcome.fallback && call.escalate_to) {
      // The declared escalation is the one retry a fruitless behavior session
      // gets before the entity falls back to static.
      outcome = await attempt(call.escalate_to);
    }
    return outcome;
  }

  private assertDependenciesSatisfied(call: PipelineCall, executed: ReadonlySet<string>): void {
    for (const dependency of call.depends_on) {
      if (!executed.has(dependency)) {
        throw new Error(`${call.id} cannot run before its declared dependency ${dependency}`);
      }
    }
  }

  private assertHardRequirements(
    call: PipelineCall,
    state: ExecutionState,
    executed: ReadonlySet<string>,
  ): void {
    for (const requirement of call.hard_requires ?? []) {
      if (!executed.has(requirement) || !isRecord(state.results[requirement])) {
        throw new PipelineBlocked(call.id, `hard_requires ${requirement} has not passed`);
      }
    }
  }

  private fanOutItems(
    call: PipelineCall,
    state: ExecutionState,
  ): Array<GameSpec["entities"][number]> {
    const pattern = call.fan_out_over ?? "";
    const parsed = pattern.match(/^([\w.]+)\[\]\.(\w+)$/);
    if (!parsed) {
      throw new Error(`${call.id} fan_out_over is not a collection selector: ${pattern}`);
    }
    const collection = getPath(state, parsed[1] ?? "");
    if (!Array.isArray(collection)) {
      throw new Error(`${call.id} fan_out_over path ${parsed[1]} did not resolve to an array`);
    }
    const field = parsed[2] ?? "";
    // The spec names the collection and discriminator field; which behaviors
    // are dynamic is the Behavior SDK's contract, not the model's to widen.
    // Behavior sessions are also spent only on roles the runtime can animate:
    // a patrolling collectible or a rising decoration can never move in Lane
    // A, so paying a model to script it would be waste by construction.
    return collection.filter((item): item is GameSpec["entities"][number] =>
      isRecord(item) &&
      typeof item[field] === "string" &&
      DYNAMIC_BEHAVIORS.has(item[field] as string) &&
      typeof item.role === "string" &&
      TRACK_ANIMATABLE_ROLES.has(item.role),
    );
  }

  /**
   * A genre decision merges into the working GameSpec. Detection is by the
   * call's declared schema, not its id, so pipeline.json stays the authority
   * over which call carries that meaning.
   */
  private applyStructuredResult(call: PipelineCall, result: unknown, state: ExecutionState): void {
    if (
      call.schema?.endsWith("genre_decision.json") &&
      isRecord(result) &&
      typeof result.primary_genre === "string" &&
      isGameSpec(state.gamespec)
    ) {
      state.gamespec.primary_genre = result.primary_genre;
    }
  }

  private async certifySolvability(
    call: PipelineCall,
    state: ExecutionState,
    context: {
      gameSpec: GameSpec;
      extractionResultId: string;
      behaviorPatches: BehaviorPatch[];
      behaviorFallbacks: Record<string, "static">;
      behaviorTracks: Record<string, BehaviorMotionTrack>;
    },
  ): Promise<{
    gameSpec: GameSpec;
    solvability: JsonObject;
    playtestReport: PlaytestReport;
    iterationsUsed: number;
    safetyRecast: boolean;
    objectiveFallback: boolean;
    recastRung: RecastRung | null;
  }> {
    let { gameSpec } = context;
    let solvability: JsonObject | undefined;
    let playtestReport = runPlaytest(gameSpec, context.behaviorTracks);
    const iterations = call.max_iterations ?? 1;
    let iterationsUsed = 0;
    let rungCursor = -1;
    let recastRung: RecastRung | null = null;
    let solvabilityPassed = false;

    const adoptWorld = (next: GameSpec, rung: RecastRung): void => {
      // Patches and certified tracks survive only for entities the rung left
      // intact; a demoted entity's behavior is dropped with it, never orphaned.
      const pruned = pruneBehaviorPatchesForWorld(
        context.behaviorPatches,
        context.behaviorFallbacks,
        gameSpec,
        next,
      );
      context.behaviorPatches.length = 0;
      context.behaviorPatches.push(...pruned.patches);
      for (const entityId of Object.keys(context.behaviorFallbacks)) {
        delete context.behaviorFallbacks[entityId];
      }
      Object.assign(context.behaviorFallbacks, pruned.fallbacks);
      const survivingPatchIds = new Set(pruned.patches.map((patch) => patch.entityId));
      for (const entityId of Object.keys(context.behaviorTracks)) {
        if (!survivingPatchIds.has(entityId)) delete context.behaviorTracks[entityId];
      }
      gameSpec = next;
      state.gamespec = gameSpec;
      state.results[context.extractionResultId] = gameSpec;
      state.results.P2 = gameSpec;
      for (const fanned of this.spec.calls) {
        if (fanned.fan_out_over) {
          state.results[fanned.id] = {
            patches: context.behaviorPatches,
            fallbacks: context.behaviorFallbacks,
          };
        }
      }
      recastRung = rung;
      this.degraded.push(`${call.id}:recast_ladder:${rung}`);
    };

    // Climbs to the next ladder rung whose candidate world the deterministic
    // playtester certifies. The cursor is monotonic: the ladder never climbs
    // down, and the terminal full-floor rung is finishable by construction.
    const advanceLadder = (report: PlaytestReport): boolean => {
      for (let index = rungCursor + 1; index < RECAST_RUNG_ORDER.length; index += 1) {
        rungCursor = index;
        const rung = RECAST_RUNG_ORDER[index];
        if (!rung) continue;
        const candidate = buildRungCandidate(rung, gameSpec, report);
        if (!candidate) continue;
        if (!runPlaytest(candidate, context.behaviorTracks).reached_goal) continue;
        adoptWorld(candidate, rung);
        return true;
      }
      return false;
    };

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      iterationsUsed = iteration + 1;
      playtestReport = runPlaytest(gameSpec, context.behaviorTracks);
      state.playtest_report = playtestReport;
      const verdict = await this.structured(call, state);
      if (!isRecord(verdict)) throw new ModelOutputError(call.id, "invalid verdict shape");
      solvability = verdict;
      state.results[call.id] = verdict;
      // The declared loop_until expression is the model's exit condition.
      // The deterministic playtest is ANDed on top and can never be overruled.
      const modelCertified = expressionIsTrue(call.loop_until, verdict);
      if (modelCertified && playtestReport.reached_goal) {
        solvabilityPassed = true;
        break;
      }
      if (modelCertified) {
        this.degraded.push(`${call.id}:false_ready:${playtestReport.first_blocker ?? "unknown"}`);
      }
      if (iteration === iterations - 1) break;

      // A locally finishable world is never altered: the playtest outranks a
      // disagreeing model verdict in both directions, so the remaining budget
      // re-certifies the same world instead of degrading the child's drawing
      // to satisfy the model.
      if (playtestReport.reached_goal) continue;

      // Model-guided bounded repair keeps priority while more than one gate
      // call remains; the last transition is reserved so whatever the ladder
      // adopts still gets its mandatory certification.
      const remaining = iterations - iterationsUsed;
      if (!modelCertified && verdict.verdict === "repair" && remaining > 1) {
        const repairResult = applyBoundedRepairs(gameSpec, verdict.repairs);
        if (repairResult.applied > 0) continue;
        this.degraded.push(`${call.id}:no_applicable_repair:${repairResult.rejected.join(",")}`);
      }
      if (!advanceLadder(playtestReport)) {
        throw new SolvabilityError(
          `${call.id} could not construct a locally finishable world; ` +
          `headless blocker: ${playtestReport.first_blocker ?? "none"}`,
        );
      }
    }
    // The model's certification budget may end without agreement, but a hard
    // failure is never the answer for a world the ladder's floor can save.
    // The playtest outranks a disagreeing model verdict in both directions:
    // if the current world is not locally finishable, the remaining rungs are
    // climbed deterministically (the terminal full-floor rung is finishable
    // by construction), and the adopted degradation is reported honestly
    // instead of throwing the child's drawing away.
    if (!solvabilityPassed && !playtestReport.reached_goal && advanceLadder(playtestReport)) {
      playtestReport = runPlaytest(gameSpec, context.behaviorTracks);
      state.playtest_report = playtestReport;
    }
    if (!solvability || !playtestReport.reached_goal) {
      throw new SolvabilityError(
        `${call.id} exhausted its repair loop before ready; ` +
        `headless blocker: ${playtestReport?.first_blocker ?? "none"}`,
      );
    }
    if (!solvabilityPassed) {
      this.degraded.push(`${call.id}:repair_loop_exhausted:playtest_certified`);
    }
    return {
      gameSpec,
      solvability,
      playtestReport,
      iterationsUsed,
      safetyRecast: recastRung === "guarded_floor" || recastRung === "full_floor",
      objectiveFallback:
        gameSpec.flags.includes("collect_all_fallback") ||
        gameSpec.flags.includes("survive_mode_fallback"),
      recastRung,
    };
  }

  async scan(
    base: PipelineContext,
    extractionId: "P2" | "P2_photo",
  ): Promise<ScanResult> {
    const scanStartedAt = performance.now();
    const state: ExecutionState = { ...base, results: {} };
    const executed = new Set<string>();
    let gameSpec: GameSpec | undefined;
    const assets: Record<string, unknown> = {};
    const behaviorPatches: BehaviorPatch[] = [];
    const behaviorFallbacks: Record<string, "static"> = {};
    const behaviorTracks: Record<string, BehaviorMotionTrack> = {};
    let solvability: JsonObject | undefined;
    let playtestReport: PlaytestReport | undefined;
    let p8Iterations = 0;
    let safetyRecast = false;
    let objectiveFallback = false;
    let recastRung: string | null = null;

    for (const step of this.spec.execution_graph.scan_path) {
      if (typeof step === "string") {
        // The graph names the drawing extractor; the declared photo alternate
        // substitutes at the same graph position when the entry selects it.
        const id = step === "P2" ? extractionId : step;
        const call = this.call(id);
        this.assertDependenciesSatisfied(call, executed);
        this.assertHardRequirements(call, state, executed);

        if (call.loop_until) {
          if (!gameSpec) throw new Error(`${call.id} loop requires an extracted GameSpec`);
          const certified = await this.certifySolvability(call, state, {
            gameSpec,
            extractionResultId: extractionId,
            behaviorPatches,
            behaviorFallbacks,
            behaviorTracks,
          });
          gameSpec = certified.gameSpec;
          solvability = certified.solvability;
          playtestReport = certified.playtestReport;
          p8Iterations = certified.iterationsUsed;
          safetyRecast = certified.safetyRecast;
          objectiveFallback = certified.objectiveFallback;
          recastRung = certified.recastRung;
        } else if (id === extractionId) {
          try {
            const extracted = await this.structured(call, state);
            if (!isGameSpec(extracted)) throw new ModelOutputError(call.id, "invalid GameSpec shape");
            gameSpec = normalizeNullableGameSpec(clone(extracted));
          } catch (error) {
            this.degraded.push(`${call.id}:${String(error)}`);
            gameSpec = fallbackGameSpec();
          }
          gameSpec.mood ??= "genre-base";
          state.results[call.id] = gameSpec;
          state.results.P2 = gameSpec;
          state.gamespec = gameSpec;
        } else if (call.optional) {
          try {
            const result = await this.structured(call, state);
            state.results[id] = result;
            this.applyStructuredResult(call, result, state);
          } catch (error) {
            this.degraded.push(`${id}:${String(error)}`);
            state.results[id] = null;
          }
        } else {
          const result = await this.structured(call, state);
          state.results[id] = result;
          if (call.blocks_pipeline_on && gateBlocks(call.blocks_pipeline_on, result)) {
            throw new PipelineBlocked(id, result);
          }
          this.applyStructuredResult(call, result, state);
        }
        executed.add(id);
        executed.add(step);
        continue;
      }

      const members = this.spec.calls.filter(
        (candidate) => candidate.parallel_group === step.parallel,
      );
      if (members.length === 0) {
        throw new Error(`Parallel group ${step.parallel} has no declared calls`);
      }
      for (const member of members) {
        this.assertDependenciesSatisfied(member, executed);
        this.assertHardRequirements(member, state, executed);
      }
      const plain = members.filter((member) => !member.fan_out_over);
      const fanned = members.filter((member) => member.fan_out_over);
      const settled = await Promise.allSettled(
        plain.map((member) => this.structured(member, state)),
      );
      for (const [index, outcome] of settled.entries()) {
        const member = plain[index];
        if (!member) continue;
        if (outcome.status === "fulfilled") {
          assets[member.id] = outcome.value;
          state.results[member.id] = outcome.value;
        } else if (member.optional) {
          assets[member.id] = null;
          state.results[member.id] = null;
          this.degraded.push(`${member.id}:${String(outcome.reason)}`);
        } else {
          throw outcome.reason;
        }
      }
      for (const member of fanned) {
        const items = this.fanOutItems(member, state);
        const results = await Promise.all(
          items.map(async (entity) => {
            try {
              return [entity.id, await this.behavior(member, state, entity)] as const;
            } catch (error) {
              this.degraded.push(`${member.id}:${entity.id}:${String(error)}`);
              return [
                entity.id,
                { patches: [], fallback: true, tracks: [] as BehaviorMotionTrack[] },
              ] as const;
            }
          }),
        );
        for (const [entityId, result] of results) {
          behaviorPatches.push(...result.patches);
          if (result.fallback) behaviorFallbacks[entityId] = "static";
          for (const track of result.tracks) {
            if (track.entityId === entityId) behaviorTracks[entityId] = track;
          }
        }
        state.results[member.id] = { patches: behaviorPatches, fallbacks: behaviorFallbacks };
      }
      for (const member of members) executed.add(member.id);
    }

    if (!gameSpec || !playtestReport || !solvability) {
      throw new Error("execution_graph.scan_path did not certify a playable game");
    }
    const metrics: GenerationMetrics = {
      totalDurationMs: performance.now() - scanStartedAt,
      calls: [...this.callMetrics],
      p8Iterations,
      safetyRecast,
      objectiveFallback,
      recastRung,
      finalGenre: gameSpec.primary_genre,
      degradedCount: this.degraded.length,
    };
    return {
      gameSpec,
      assets,
      behaviorPatches,
      behaviorFallbacks,
      behaviorTracks,
      playtestReport,
      solvability,
      calls: [...this.traces],
      degraded: [...this.degraded],
      metrics,
    };
  }

  async single(callId: string, base: PipelineContext): Promise<unknown> {
    const state: ExecutionState = { ...base, results: {} };
    if (isGameSpec(base.gamespec)) state.gamespec = base.gamespec;
    return this.structured(this.call(callId), state);
  }

  /**
   * The physical rescan loop: the child edits their paper and rescans it.
   * The merged world passes the SAME ordered gates as a first scan — P1 on
   * the new capture, strict schema plus shape validation on the stitched
   * GameSpec, then the full P8 certify loop (bounded repair, recast ladder,
   * deterministic playtest that the model can never overrule). There is
   * deliberately no fallback-spec substitution on this path: a rescan that
   * cannot be gated fails closed, and the child keeps their previous,
   * already-certified game instead of a generic replacement world.
   */
  async rescan(input: {
    gamespec_existing: GameSpec;
    image_new: string;
    behaviorTracks?: Record<string, BehaviorMotionTrack>;
  }): Promise<ScanResult> {
    const scanStartedAt = performance.now();
    const state: ExecutionState = {
      image: input.image_new,
      image_new: input.image_new,
      gamespec_existing: input.gamespec_existing,
      new_page_scanned: true,
      results: {},
    };

    // P1 runs on the changed paper before any generation, exactly as it does
    // for a first scan; an unresolved or blocking verdict stops everything.
    const safety = this.call("P1");
    const safetyVerdict = await this.structured(safety, state);
    state.results[safety.id] = safetyVerdict;
    if (safety.blocks_pipeline_on && gateBlocks(safety.blocks_pipeline_on, safetyVerdict)) {
      throw new PipelineBlocked(safety.id, safetyVerdict);
    }

    const stitch = this.call("P10");
    const merged = await this.structured(stitch, state);
    if (!isGameSpec(merged)) {
      throw new ModelOutputError(stitch.id, "invalid stitched GameSpec shape");
    }
    let gameSpec = normalizeNullableGameSpec(clone(merged));
    gameSpec.mood ??= "genre-base";
    state.results[stitch.id] = gameSpec;
    state.results.P2 = gameSpec;
    state.gamespec = gameSpec;

    // Only certified tracks whose entity survived the merge with the same
    // animatable dynamic contract keep moving. Everything else is dropped
    // with its entity so stale motion can never replay into the grown world.
    const behaviorTracks: Record<string, BehaviorMotionTrack> = {};
    for (const [entityId, track] of Object.entries(input.behaviorTracks ?? {})) {
      const survivor = gameSpec.entities.find((entity) => entity.id === entityId);
      if (
        survivor &&
        DYNAMIC_BEHAVIORS.has(survivor.behavior) &&
        TRACK_ANIMATABLE_ROLES.has(survivor.role)
      ) {
        behaviorTracks[entityId] = track;
      }
    }

    const behaviorPatches: BehaviorPatch[] = [];
    const behaviorFallbacks: Record<string, "static"> = {};
    const certified = await this.certifySolvability(this.call("P8"), state, {
      gameSpec,
      extractionResultId: stitch.id,
      behaviorPatches,
      behaviorFallbacks,
      behaviorTracks,
    });
    gameSpec = certified.gameSpec;

    const metrics: GenerationMetrics = {
      totalDurationMs: performance.now() - scanStartedAt,
      calls: [...this.callMetrics],
      p8Iterations: certified.iterationsUsed,
      safetyRecast: certified.safetyRecast,
      objectiveFallback: certified.objectiveFallback,
      recastRung: certified.recastRung,
      finalGenre: gameSpec.primary_genre,
      degradedCount: this.degraded.length,
    };
    return {
      gameSpec,
      assets: {},
      behaviorPatches,
      behaviorFallbacks,
      behaviorTracks,
      playtestReport: certified.playtestReport,
      solvability: certified.solvability,
      calls: [...this.traces],
      degraded: [...this.degraded],
      metrics,
    };
  }
}

export async function runDrawingScan(
  input: { image: string; context?: unknown },
  options: RunnerOptions,
): Promise<ScanResult> {
  const runner = new PipelineRunner(options);
  return runner.scan({ ...input, context: input.context ?? {} }, "P2");
}

export async function runPhotoScan(
  input: { photo: string; annotations?: unknown },
  options: RunnerOptions,
): Promise<ScanResult> {
  const runner = new PipelineRunner(options);
  return runner.scan({ ...input, image: input.photo, input_mode: "photo" }, "P2_photo");
}

export async function runPipeline(
  input: { image: string; context?: unknown } | { photo: string; annotations?: unknown },
  options: RunnerOptions,
): Promise<ScanResult> {
  return "photo" in input
    ? runPhotoScan(input, options)
    : runDrawingScan(input, options);
}

export async function runVoiceEdit(
  input: { gamespec: GameSpec; utterance: string },
  options: RunnerOptions,
): Promise<unknown> {
  const runner = new PipelineRunner(options);
  const parsed = parseEditDiffJson(await runner.single("P9", input));
  if (parsed.needs_code !== true) return parsed;
  const call = runner.call("P9");
  if (!call.then) throw new Error("P9 needs_code but declares no then model");
  const entity = input.gamespec.entities.find((item) => DYNAMIC_BEHAVIORS.has(item.behavior));
  if (!entity) return { ...parsed, patches: [], fallback: "static" };
  const state: ExecutionState = { ...input, results: { P9: parsed }, gamespec: input.gamespec };
  const behavior = await runner.behavior(call, state, entity, call.then);
  return { ...parsed, patches: behavior.patches, fallback: behavior.fallback ? "static" : undefined };
}

/**
 * Stitches a rescanned/added page onto an existing certified world through
 * every ordered gate. The result is a full ScanResult — never raw P10 output —
 * so no playable document can be produced from an ungated stitched spec.
 */
export async function runMultipageStitch(
  input: {
    gamespec_existing: GameSpec;
    image_new: string;
    behaviorTracks?: Record<string, BehaviorMotionTrack>;
  },
  options: RunnerOptions,
): Promise<ScanResult> {
  const runner = new PipelineRunner(options);
  return runner.rescan(input);
}

export async function runShareModeration(
  input: {
    rendered_game: string;
    title: string;
    playtestReport: PlaytestReport;
    solvability: JsonObject;
  },
  options: RunnerOptions,
): Promise<unknown> {
  if (input.solvability.verdict !== "ready" || !input.playtestReport.reached_goal) {
    throw new SolvabilityError("P11 cannot run before a passing P8 playtest gate");
  }
  const runner = new PipelineRunner(options);
  const call = runner.call("P11");
  const result = await runner.single("P11", { ...input, on_share: true });
  // The loader guarantees every gate lane declares its blocking rule, so this
  // cannot silently weaken if pipeline.json drops the declaration.
  if (gateBlocks(call.blocks_pipeline_on, result)) {
    throw new PipelineBlocked("P11", result);
  }
  return result;
}

/**
 * Names the gate's schema-validated enum fields (never free text, never
 * content) in the block message. Reports that only keep error.message —
 * like the drawing-set validation report — would otherwise record a block
 * with no reason, which is how the P1 false-positive class went undiagnosed.
 */
function describeGateVerdict(verdict: unknown): string {
  if (!isRecord(verdict)) return "";
  const parts: string[] = [];
  for (const field of ["verdict", "publishable", "reason_code"]) {
    const value = verdict[field];
    if (typeof value === "string" || typeof value === "boolean") {
      parts.push(`${field}=${String(value)}`);
    }
  }
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

export class PipelineBlocked extends Error {
  constructor(
    public readonly callId: string,
    public readonly verdict: unknown,
  ) {
    super(`Pipeline blocked at ${callId}${describeGateVerdict(verdict)}`);
    this.name = "PipelineBlocked";
  }
}

export class ModelOutputError extends Error {
  constructor(public readonly callId: string, message: string) {
    super(`${callId}: ${message}`);
    this.name = "ModelOutputError";
  }
}

export class SolvabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SolvabilityError";
  }
}
