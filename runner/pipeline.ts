import OpenAI from "openai";
import type { Responses } from "openai/resources/responses/responses";

import { validateBehaviorOperation } from "../packages/sdk/src/validator.js";
import { P8_SYNTHETIC_ENTITY_PREFIX } from "../packages/runtime/src/synthetic-entity.js";
import {
  applyBoundedRepairs,
  runPlaytest,
} from "../services/solve/src/playtest.js";
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
  GameSpec,
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
  skipSchema?: boolean;
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

function expressionIsTrue(expression: string | undefined, state: ExecutionState): boolean {
  if (!expression) return true;
  const includes = expression.match(/^([\w.]+)\s+includes\s+["']([^"']+)["']$/);
  if (includes) {
    const value = getPath(state, includes[1] ?? "");
    return Array.isArray(value) && value.includes(includes[2]);
  }
  if (/^[\w.]+$/.test(expression)) {
    return Boolean(getPath(state, expression));
  }
  const equality = expression.match(/^([\w.]+)\s*(==|!=)\s*["']?([^"']+?)["']?$/);
  if (!equality) throw new Error(`Unsupported spec expression: ${expression}`);
  const value = getPath(state, equality[1] ?? "");
  const matches = String(value) === equality[3];
  return equality[2] === "!=" ? !matches : matches;
}

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

function uniqueEntityId(base: string, used: Set<string>): string {
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${base}_${suffix++}`;
  used.add(candidate);
  return candidate;
}

/**
 * Converts any extracted world into the deterministic Lane A floor without
 * recognizing drawing nouns. Original hero/entity crops remain at their
 * drawn coordinates as non-colliding art; only the mechanics are recast to a
 * ground route and a generated finish on the opposite side of the hero.
 */
export function createDeterministicSafetyRecast(source: GameSpec): GameSpec {
  const used = new Set<string>([source.hero.id]);
  const decorations = source.entities.map((entity, index) => ({
    ...entity,
    // The model's ids remain data, never trusted provenance. Re-key source
    // marks into a separate namespace so only runner-created mechanics can
    // carry the reserved synthetic prefix used by Lane A rendering.
    id: uniqueEntityId(`drawing_mark_${index + 1}`, used),
    role: "decoration",
    behavior: "static",
    linked_to: null,
    bbox: [...entity.bbox] as GameSpec["entities"][number]["bbox"],
  }));
  const groundId = uniqueEntityId(`${P8_SYNTHETIC_ENTITY_PREFIX}ground`, used);
  const goalId = uniqueEntityId(`${P8_SYNTHETIC_ENTITY_PREFIX}finish`, used);
  const heroCenter = (source.hero.bbox[0] + source.hero.bbox[2]) / 2;
  const goalLeft = heroCenter <= 0.5 ? 0.82 : 0.06;
  return {
    ...source,
    primary_genre: "platformer",
    genre_confidence: 0,
    hero: { ...source.hero, bbox: [...source.hero.bbox] },
    entities: [
      ...decorations,
      {
        id: groundId,
        role: "platform",
        bbox: [0.02, 0.9, 0.98, 0.96],
        behavior: "static",
        linked_to: null,
        style_ref: "synthetic-ground",
      },
      {
        id: goalId,
        role: "goal",
        bbox: [goalLeft, 0.7, goalLeft + 0.12, 0.9],
        behavior: "static",
        linked_to: null,
        style_ref: "synthetic-finish",
      },
    ],
    goal: { kind: "reach_goal", target_id: goalId },
    rules: { ...source.rules, difficulty_hint: "chill", modifiers: [] },
    palette: [...source.palette],
    assumptions: [
      ...source.assumptions,
      "Lane A recast the mechanics to its deterministic finishable floor after the solvability repair loop.",
    ],
    flags: [...new Set([...source.flags, "p8_safety_recast"])],
  };
}

function isGameSpec(value: unknown): value is GameSpec {
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
        id: "mover_1",
        role: "mover",
        bbox: [0.15, 0.55, 0.32, 0.72],
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
  private client: ResponsesClient | undefined;
  private attempts = new Map<string, number>();

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
    const schema = override.skipSchema ? undefined : loadSchema(this.root, call);
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
      text: { verbosity: this.spec.globals.text_verbosity_json },
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
      model: String(request.model),
      effort,
      attempt,
      safetyIdentifier: request.safety_identifier ?? "",
    };
    this.traces.push(trace);
    this.options.onRequest?.(trace, request);

    if (this.options.dryRun) {
      return {
        id: `dry-${call.id}-${attempt}`,
        output_text: JSON.stringify(dryRunOutput(call.id)),
        output: [],
      };
    }
    if (!this.client) this.client = new OpenAI() as unknown as ResponsesClient;
    this.options.signal?.throwIfAborted();
    return this.client.responses.create(
      request,
      this.options.signal ? { signal: this.options.signal } : undefined,
    );
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
  ): Promise<{ patches: BehaviorPatch[]; fallback: boolean }> {
    const request = this.buildRequest(call, state, {
      input: this.buildInput(call, state, { item: entity }),
      modelAlias,
      skipSchema: call.id === "P7",
    });
    let response = await this.send(call, request, modelAlias);
    if (this.options.dryRun) return { patches: [], fallback: false };

    const patches: BehaviorPatch[] = [];
    for (let round = 0; round < 6; round += 1) {
      const patchCalls = response.output.filter(
        (item): item is Responses.ResponseApplyPatchToolCall =>
          item.type === "apply_patch_call",
      );
      if (patchCalls.length === 0) {
        return { patches, fallback: patches.length === 0 };
      }
      const outputs: Responses.ResponseInput = [];
      for (const patchCall of patchCalls) {
        const validation = await validateBehaviorOperation(
          patchCall.operation,
          entity.id,
        );
        if (validation.valid && validation.patch) patches.push(validation.patch);
        outputs.push({
          type: "apply_patch_call_output",
          call_id: patchCall.call_id,
          status: validation.valid ? "completed" : "failed",
          output: validation.valid ? "headless_sdk_validator:passed" : validation.errors.join(","),
        });
      }
      const continuation = this.buildRequest(call, state, {
        input: [...response.output, ...outputs] as Responses.ResponseInput,
        modelAlias,
        skipSchema: call.id === "P7",
      });
      response = await this.send(call, continuation, modelAlias);
    }
    return { patches: [], fallback: true };
  }

  async scan(
    base: PipelineContext,
    extractionId: "P2" | "P2_photo",
  ): Promise<ScanResult> {
    const state: ExecutionState = { ...base, results: {} };
    const p1 = this.call("P1");
    const safety = await this.structured(p1, state);
    state.results.P1 = safety;
    if (!isRecord(safety) || safety.verdict !== "allow") {
      throw new PipelineBlocked("P1", safety);
    }

    const calibration = this.call("P0_calibrate");
    try {
      state.results.P0_calibrate = await this.structured(calibration, state);
    } catch (error) {
      this.degraded.push(`P0_calibrate:${String(error)}`);
      state.results.P0_calibrate = null;
    }

    const extraction = this.call(extractionId);
    let gameSpec: GameSpec;
    try {
      const extracted = await this.structured(extraction, state);
      if (!isGameSpec(extracted)) throw new ModelOutputError(extraction.id, "invalid GameSpec shape");
      gameSpec = normalizeNullableGameSpec(clone(extracted));
    } catch (error) {
      this.degraded.push(`${extraction.id}:${String(error)}`);
      gameSpec = fallbackGameSpec();
    }
    gameSpec.mood ??= "genre-base";
    state.results[extraction.id] = gameSpec;
    state.results.P2 = gameSpec;
    state.gamespec = gameSpec;

    const assetCalls = ["P3", "P4", "P5"].map((id) => this.call(id));
    if (!assetCalls.every((call) => call.parallel_group === "assets")) {
      throw new Error("Only the declared assets parallel_group may fan out here");
    }
    const assetResults = await Promise.allSettled(
      assetCalls.map((call) => this.structured(call, state)),
    );
    const assets: Record<string, unknown> = {};
    for (const [index, settled] of assetResults.entries()) {
      const call = assetCalls[index];
      if (!call) continue;
      if (settled.status === "fulfilled") {
        assets[call.id] = settled.value;
        state.results[call.id] = settled.value;
      } else {
        assets[call.id] = null;
        state.results[call.id] = null;
        this.degraded.push(`${call.id}:${String(settled.reason)}`);
      }
    }

    const p6 = this.call("P6");
    if (expressionIsTrue(p6.run_if, state)) {
      try {
        const genre = await this.structured(p6, state);
        state.results.P6 = genre;
        if (isRecord(genre) && typeof genre.primary_genre === "string") {
          gameSpec.primary_genre = genre.primary_genre;
        }
      } catch (error) {
        state.results.P6 = null;
        this.degraded.push(`P6:${String(error)}`);
      }
    } else {
      state.results.P6 = null;
    }

    const p7 = this.call("P7");
    if (p7.parallel_group !== "behaviors") {
      throw new Error("P7 must remain in the behaviors parallel_group");
    }
    const dynamicEntities = gameSpec.entities.filter((entity) =>
      DYNAMIC_BEHAVIORS.has(entity.behavior),
    );
    const behaviorResults = await Promise.all(
      dynamicEntities.map(async (entity) => {
        try {
          return [entity.id, await this.behavior(p7, state, entity)] as const;
        } catch (error) {
          this.degraded.push(`P7:${entity.id}:${String(error)}`);
          return [entity.id, { patches: [], fallback: true }] as const;
        }
      }),
    );
    const behaviorPatches: BehaviorPatch[] = [];
    const behaviorFallbacks: Record<string, "static"> = {};
    for (const [entityId, result] of behaviorResults) {
      behaviorPatches.push(...result.patches);
      if (result.fallback) behaviorFallbacks[entityId] = "static";
    }
    state.results.P7 = { patches: behaviorPatches, fallbacks: behaviorFallbacks };

    const p8 = this.call("P8");
    let solvability: JsonObject | undefined;
    let playtestReport = runPlaytest(gameSpec);
    const iterations = p8.max_iterations ?? 1;
    let objectiveFallbackApplied = false;
    let safetyRecastApplied = false;
    let solvabilityPassed = false;
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      playtestReport = runPlaytest(gameSpec);
      state.playtest_report = playtestReport;
      const verdict = await this.structured(p8, state);
      if (!isRecord(verdict)) throw new ModelOutputError("P8", "invalid verdict shape");
      solvability = verdict;
      state.results.P8 = verdict;
      if (verdict.verdict === "ready") {
        if (playtestReport.reached_goal) {
          solvabilityPassed = true;
          break;
        }
        // P8 remains a hard gate: a model verdict can never overrule the
        // deterministic playtest. Treat false-ready as a repair outcome and
        // spend the remaining declared iterations on a safe recast.
        this.degraded.push(`P8:false_ready:${playtestReport.first_blocker ?? "unknown"}`);
      }

      const effectiveVerdict = verdict.verdict === "ready" ? "repair" : verdict.verdict;
      const reserveFinalCertification = iteration >= iterations - 2;
      if (!safetyRecastApplied && (
        verdict.verdict === "ready" || objectiveFallbackApplied || reserveFinalCertification
      )) {
        gameSpec = createDeterministicSafetyRecast(gameSpec);
        state.gamespec = gameSpec;
        state.results[extraction.id] = gameSpec;
        state.results.P2 = gameSpec;
        behaviorPatches.length = 0;
        for (const entityId of Object.keys(behaviorFallbacks)) delete behaviorFallbacks[entityId];
        state.results.P7 = { patches: [], fallbacks: {} };
        safetyRecastApplied = true;
        this.degraded.push("P8:deterministic_safety_recast");
        continue;
      }
      if (safetyRecastApplied) {
        // The recast is the final deterministic mutation. Every remaining
        // declared attempt is reserved for P8 to certify that exact world;
        // non-ready verdicts cannot trigger another fallback or abort early.
        continue;
      }
      if (effectiveVerdict === "repair") {
        const repairResult = applyBoundedRepairs(gameSpec, verdict.repairs);
        if (repairResult.applied > 0) {
          continue;
        }
        this.degraded.push(`P8:no_applicable_repair:${repairResult.rejected.join(",")}`);
      }
      if (!objectiveFallbackApplied && (
        effectiveVerdict === "unsolvable_by_design" || effectiveVerdict === "repair"
      )) {
        // A child can draw a world without declaring an explicit finish line.
        // Use the GameSpec's own semantic inventory before falling back to a
        // timer: found collectibles become the objective. P8 still reruns and
        // must approve; this never skips or reorders the gate.
        const hasCollectibles = gameSpec.entities.some((entity) => entity.role === "collectible");
        gameSpec.goal = hasCollectibles
          ? { kind: "collect_all", target_id: null }
          : { kind: "survive", target_id: null };
        const fallbackFlag = hasCollectibles ? "collect_all_fallback" : "survive_mode_fallback";
        if (!gameSpec.flags.includes(fallbackFlag)) gameSpec.flags.push(fallbackFlag);
        objectiveFallbackApplied = true;
        continue;
      }
      throw new SolvabilityError(
        `P8 did not approve the game: ${String(effectiveVerdict)}; ` +
        `headless blocker: ${playtestReport.first_blocker ?? "none"}`,
      );
    }
    if (!solvabilityPassed || !solvability || solvability.verdict !== "ready" || !playtestReport.reached_goal) {
      throw new SolvabilityError(
        `P8 exhausted its repair loop before ready; ` +
        `headless blocker: ${playtestReport?.first_blocker ?? "none"}`,
      );
    }

    return {
      gameSpec,
      assets,
      behaviorPatches,
      behaviorFallbacks,
      playtestReport,
      solvability,
      calls: [...this.traces],
      degraded: [...this.degraded],
    };
  }

  async single(callId: string, base: PipelineContext): Promise<unknown> {
    const state: ExecutionState = { ...base, results: {} };
    if (isGameSpec(base.gamespec)) state.gamespec = base.gamespec;
    return this.structured(this.call(callId), state);
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

export async function runMultipageStitch(
  input: { gamespec_existing: GameSpec; image_new: string; new_page_scanned?: boolean },
  options: RunnerOptions,
): Promise<unknown> {
  const runner = new PipelineRunner(options);
  return runner.single("P10", { ...input, new_page_scanned: input.new_page_scanned ?? true });
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
  const result = await runner.single("P11", { ...input, on_share: true });
  if (!isRecord(result) || result.publishable !== true) {
    throw new PipelineBlocked("P11", result);
  }
  return result;
}

export class PipelineBlocked extends Error {
  constructor(
    public readonly callId: string,
    public readonly verdict: unknown,
  ) {
    super(`Pipeline blocked at ${callId}`);
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
