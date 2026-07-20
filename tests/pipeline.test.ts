import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import type { Responses } from "openai/resources/responses/responses";

import {
  createDeterministicSafetyRecast,
  ModelOutputError,
  PipelineBlocked,
  SolvabilityError,
  runMultipageStitch,
  runPhotoScan,
  runPipeline,
  runShareModeration,
  runVoiceEdit,
} from "../runner/pipeline.js";
import { runPlaytest } from "../services/solve/src/playtest.js";
import { validateJsonSchema } from "../runner/schema-validation.js";
import { generateDrawingGame } from "../services/gen/src/drawing-service.js";
import {
  createDrawingGenerationHandler,
  createDrawingGenerationStreamHandler,
} from "../services/gen/src/http.js";
import { moderateShareCandidate } from "../services/share/src/share-service.js";
import { createPlayContract } from "../packages/runtime/src/play-contract.js";
import { createPlatformerPlan } from "../packages/runtime/src/platformer-layout.js";
import type { RuntimeTraceReport } from "../services/solve/src/runtime-trace.js";
import {
  findProjectRoot,
  loadJson,
  loadPipelineSpec,
  resolveProjectFile,
  validatePipelineSpec,
} from "../runner/spec.js";
import type {
  PipelineCall,
  ResponsesClient,
  SchemaDocument,
  GameSpec,
  JsonObject,
} from "../runner/types.js";

const SERVICE_SAFETY_ID = "a".repeat(64);
const REQUEST_ID = "test-request-0001";

const SHAREABLE_GAME_SPEC: GameSpec = {
  primary_genre: "platformer", genre_confidence: 1, mood: null,
  hero: { id: "hero", name: "Hero", bbox: [0.1, 0.5, 0.2, 0.7], style_ref: "source" },
  entities: [
    { id: "floor", role: "platform", bbox: [0, 0.72, 1, 0.8], behavior: "static", linked_to: null, style_ref: "source" },
    { id: "finish", role: "goal", bbox: [0.8, 0.5, 0.9, 0.7], behavior: "static", linked_to: null, style_ref: "source" },
  ],
  goal: { kind: "reach_goal", target_id: "finish" },
  rules: { lives: 3, difficulty_hint: "normal", modifiers: [] },
  palette: ["#ffffff"], assumptions: [], flags: [],
};
const FAITHFUL_SHARE_CONTRACT = createPlayContract(SHAREABLE_GAME_SPEC);
const FAITHFUL_RUNTIME_REPORT: RuntimeTraceReport = {
  format: "inkling-runtime-trace-report-v1",
  contractFormat: FAITHFUL_SHARE_CONTRACT.format,
  templateId: FAITHFUL_SHARE_CONTRACT.templateId,
  runtimeVersion: FAITHFUL_SHARE_CONTRACT.runtimeVersion,
  valid: true,
  blockers: [],
  inputAccepted: true,
  reachedTerminalState: true,
  finalStatus: "won",
  finalFrame: 180,
};

const root = findProjectRoot();
const spec = loadPipelineSpec(root);

test("the final P8 safety recast is deterministic, art-preserving, and finishable", () => {
  const unsafe = structuredClone(SHAREABLE_GAME_SPEC);
  unsafe.primary_genre = "shooter";
  unsafe.hero.bbox = [0.76, 0.04, 0.94, 0.24];
  unsafe.entities = [
    { id: "hero", role: "hazard", bbox: [0, 0, 1, 1], behavior: "chase", linked_to: "missing", style_ref: "child-ink" },
    { id: "hero", role: "boss", bbox: [0.4, 0.2, 0.7, 0.8], behavior: "shooter", linked_to: null, style_ref: "child-paint" },
  ];
  unsafe.goal = { kind: "defeat_boss", target_id: "missing" };

  const first = createDeterministicSafetyRecast(unsafe);
  const second = createDeterministicSafetyRecast(unsafe);
  assert.deepEqual(first, second);
  assert.equal(first.primary_genre, "platformer");
  assert.ok(first.flags.includes("p8_safety_recast"));
  assert.deepEqual(first.hero, unsafe.hero, "the child's extracted hero crop must remain unchanged");
  assert.deepEqual(
    first.entities.slice(0, unsafe.entities.length).map(({ bbox, style_ref }) => ({ bbox, style_ref })),
    unsafe.entities.map(({ bbox, style_ref }) => ({ bbox, style_ref })),
    "every original entity crop and style reference must remain unchanged",
  );
  assert.ok(first.entities.slice(0, unsafe.entities.length).every((entity) => (
    entity.role === "decoration" && entity.behavior === "static" && entity.linked_to === null
  )));
  assert.equal(new Set(first.entities.map((entity) => entity.id)).size, first.entities.length);
  assert.equal(createPlayContract(first).outcome, "related_fallback");
  assert.equal(runPlaytest(first).reached_goal, true);
});

test("P8 spends its declared loop on a certified safety recast instead of returning a retry", async () => {
  let activeCallId = "";
  let p8Attempts = 0;
  const client: ResponsesClient = {
    responses: {
      async create() {
        const callId = activeCallId;
        const value = callId === "P1"
          ? { verdict: "allow", reason_code: "none" }
          : callId === "P0_calibrate"
            ? { complexity: "simple" }
            : callId === "P2"
              ? SHAREABLE_GAME_SPEC
              : callId === "P3"
                ? { topology: "blob", tier: "squash_stretch_puppet", joints: [], animations: ["idle"], style_ref: null }
                : callId === "P4"
                  ? { layers: [{ source: "source-page", parallax: 0.5 }] }
                  : callId === "P5"
                    ? { music_pack_id: "base", sfx_pack_id: "base" }
                    : callId === "P8"
                      ? ++p8Attempts < 3
                        ? { verdict: "unsolvable_by_design", repairs: null, fallback: "survive_mode" }
                        : { verdict: "ready", repairs: [], fallback: "none" }
                      : {};
        return { id: `mock-${callId}`, output_text: JSON.stringify(value), output: [] };
      },
    },
  };

  const result = await runPipeline(
    { image: "data:image/png;base64,cDgtc2FmZXR5LXJlY2FzdA==" },
    {
      safetyId: "p8-safety-recast-user",
      client,
      onRequest(trace) {
        activeCallId = trace.callId;
      },
    },
  );
  assert.equal(p8Attempts, 3, "the final P8 call must certify the recast rather than be skipped");
  assert.equal(result.solvability.verdict, "ready");
  assert.equal(result.playtestReport.reached_goal, true);
  assert.ok(result.gameSpec.flags.includes("p8_safety_recast"));
  assert.ok(result.degraded.includes("P8:deterministic_safety_recast"));
  assert.equal(createPlayContract(result.gameSpec).outcome, "related_fallback");
});

const BLOCKED_GAME_SPEC: GameSpec = {
  ...structuredClone(SHAREABLE_GAME_SPEC),
  entities: [
    SHAREABLE_GAME_SPEC.entities[0]!,
    { id: "door", role: "door", bbox: [0.48, 0.25, 0.55, 0.8], behavior: "static", linked_to: null, style_ref: "source" },
    SHAREABLE_GAME_SPEC.entities[1]!,
  ],
};

function pipelineWithP8Sequence(
  verdicts: JsonObject[],
  gameSpec: GameSpec = SHAREABLE_GAME_SPEC,
): { result: ReturnType<typeof runPipeline>; attempts: () => number } {
  let activeCallId = "";
  let attempts = 0;
  const client: ResponsesClient = { responses: { async create() {
    const value = activeCallId === "P1" ? { verdict: "allow", reason_code: "none" }
      : activeCallId === "P0_calibrate" ? { complexity: "simple" }
      : activeCallId === "P2" ? gameSpec
      : activeCallId === "P3" ? { topology: "blob", tier: "squash_stretch_puppet", joints: [], animations: ["idle"], style_ref: null }
      : activeCallId === "P4" ? { layers: [{ source: "source-page", parallax: 0.5 }] }
      : activeCallId === "P5" ? { music_pack_id: "base", sfx_pack_id: "base" }
      : activeCallId === "P8" ? verdicts[Math.min(attempts++, verdicts.length - 1)]
      : {};
    return { id: `mock-${activeCallId}`, output_text: JSON.stringify(value), output: [] };
  } } };
  return {
    result: runPipeline(
      { image: "data:image/png;base64,cDgtc3RhdGUtbWFjaGluZQ==" },
      { safetyId: "p8-state-machine-user", client, onRequest(trace) { activeCallId = trace.callId; } },
    ),
    attempts: () => attempts,
  };
}

test("P8 uses every remaining certification attempt after recast and fails closed", async () => {
  for (const verdict of [
    { verdict: "repair", repairs: null, fallback: null },
    { verdict: "unsolvable_by_design", repairs: null, fallback: "survive_mode" },
  ]) {
    const run = pipelineWithP8Sequence([verdict]);
    await assert.rejects(run.result, SolvabilityError);
    assert.equal(run.attempts(), 4, "all four declared P8 attempts must run before fail-closed exhaustion");
  }
});

test("persistent false-ready is accepted only after the deterministic recast passes locally", async () => {
  assert.equal(runPlaytest(BLOCKED_GAME_SPEC).reached_goal, false);
  const run = pipelineWithP8Sequence([
    { verdict: "ready", repairs: [], fallback: "none" },
  ], BLOCKED_GAME_SPEC);
  const result = await run.result;
  assert.equal(run.attempts(), 2, "the false-ready result must trigger recast before another P8 certification");
  assert.ok(result.degraded.some((entry) => entry.startsWith("P8:false_ready:")));
  assert.ok(result.gameSpec.flags.includes("p8_safety_recast"));
  assert.equal(result.playtestReport.reached_goal, true);
});

test("mixed P8 outcomes certify the final recast without skipping the ordered gate", async () => {
  const run = pipelineWithP8Sequence([
    { verdict: "repair", repairs: null, fallback: null },
    { verdict: "unsolvable_by_design", repairs: null, fallback: "survive_mode" },
    { verdict: "ready", repairs: [], fallback: "none" },
  ]);
  const result = await run.result;
  assert.equal(run.attempts(), 3);
  assert.equal(result.solvability.verdict, "ready");
  assert.ok(result.gameSpec.flags.includes("p8_safety_recast"));
});

test("model style metadata cannot masquerade as trusted synthetic provenance", () => {
  const source = structuredClone(SHAREABLE_GAME_SPEC);
  source.entities[1]!.style_ref = "lane-a-placeholder";
  const plan = createPlatformerPlan(source);
  assert.equal(plan.goal.styleRef, "lane-a-placeholder");
  assert.equal(plan.goal.artworkSource, "drawing", "the source crop remains eligible for artwork rendering");

  const recast = createPlatformerPlan(createDeterministicSafetyRecast(source));
  assert.equal(recast.goal.artworkSource, "synthetic");
});

function assertSchemaNode(node: unknown, location: string): void {
  assert.equal(typeof node, "object", `${location} must be an object`);
  assert.notEqual(node, null, `${location} must not be null`);
  const schema = node as Record<string, unknown>;
  if (schema.type !== undefined) {
    const validTypes = ["object", "array", "string", "number", "integer", "boolean", "null"];
    if (Array.isArray(schema.type)) {
      assert.ok(schema.type.every((type) => validTypes.includes(String(type))), `${location} has invalid type`);
    } else {
      assert.ok(validTypes.includes(String(schema.type)), `${location} has invalid type`);
    }
  }
  if (schema.properties !== undefined) {
    assert.equal(typeof schema.properties, "object", `${location}.properties must be an object`);
    for (const [key, property] of Object.entries(schema.properties as Record<string, unknown>)) {
      assertSchemaNode(property, `${location}.properties.${key}`);
    }
  }
  if (schema.items !== undefined) assertSchemaNode(schema.items, `${location}.items`);
  if (schema.required !== undefined) {
    assert.ok(Array.isArray(schema.required), `${location}.required must be an array`);
    const properties = schema.properties as Record<string, unknown> | undefined;
    if (properties) {
      for (const key of schema.required as unknown[]) {
        assert.equal(typeof key, "string", `${location}.required values must be strings`);
        assert.ok(String(key) in properties, `${location}.required references missing property ${String(key)}`);
      }
    }
  }
  if (schema.additionalProperties !== undefined) {
    assert.equal(typeof schema.additionalProperties, "boolean", `${location}.additionalProperties must be boolean`);
  }
}

function assertAcyclic(calls: PipelineCall[]): void {
  const byId = new Map(calls.map((call) => [call.id, call]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    assert.ok(!visiting.has(id), `dependency cycle includes ${id}`);
    visiting.add(id);
    const call = byId.get(id);
    assert.ok(call, `unknown call ${id}`);
    for (const dependency of call.depends_on) visit(dependency);
    if (call.effort_router) visit(call.effort_router.call);
    visiting.delete(id);
    visited.add(id);
  };
  for (const call of calls) visit(call.id);
}

test("pipeline materialization is complete, strict, and acyclic", () => {
  assertAcyclic(spec.calls);
  for (const call of spec.calls) {
    const promptPath = resolveProjectFile(root, call.prompt);
    assert.ok(existsSync(promptPath), `${call.id} prompt is missing`);
    assert.ok(readFileSync(promptPath, "utf8").trim().length > 0, `${call.id} prompt is empty`);
    if (!call.schema) continue;
    const schemaPath = resolveProjectFile(root, call.schema);
    assert.ok(existsSync(schemaPath), `${call.id} schema is missing`);
    const document = loadJson<SchemaDocument>(root, call.schema);
    assert.equal(document.strict, true, `${call.id} schema must be strict`);
    assert.match(document.name, /^[A-Za-z0-9_-]{1,64}$/);
    assertSchemaNode(document.schema, call.schema);
  }
});

test("response schemas reject malformed values before they can affect the pipeline", () => {
  const gameSpec = loadJson<SchemaDocument>(root, "spec/schemas/gamespec.json");
  const issues = validateJsonSchema(
    {
      primary_genre: "not-a-genre",
      genre_confidence: 1.5,
      unexpected: true,
    },
    gameSpec.schema,
  );
  assert.ok(issues.some((issue) => issue.path === "$.unexpected"));
  assert.ok(issues.some((issue) => issue.path === "$.primary_genre"));
  assert.ok(issues.some((issue) => issue.path === "$.genre_confidence"));
  assert.ok(issues.some((issue) => issue.path === "$.hero" && issue.message === "is required"));
});

test("drawing dry-run follows gates and declared model/effort routing", async () => {
  const requests: Array<{
    callId: string;
    request: Responses.ResponseCreateParamsNonStreaming;
  }> = [];
  const result = await runPipeline(
    { image: "data:image/png;base64,dry", context: { capture_surface: "paper" } },
    {
      safetyId: "dry-user-hash",
      dryRun: true,
      onRequest(trace, request) {
        requests.push({ callId: trace.callId, request });
      },
    },
  );

  assert.equal(result.solvability.verdict, "ready");
  assert.equal(result.playtestReport.reached_goal, true);
  assert.deepEqual(
    requests.map(({ callId }) => callId),
    ["P1", "P0_calibrate", "P2", "P3", "P4", "P5", "P6", "P7", "P8"],
  );
  assert.deepEqual(
    result.metrics.calls.map((call) => call.callId).sort(),
    requests.map(({ callId }) => callId).sort(),
    "every executed call must be measured",
  );
  assert.ok(result.metrics.calls.every((call) => call.durationMs >= 0 && call.callName.length > 0));
  assert.ok(result.metrics.totalDurationMs >= 0);
  assert.equal(result.metrics.p8Iterations, 1);
  assert.equal(result.metrics.safetyRecast, false);
  assert.equal(result.metrics.finalGenre, result.gameSpec.primary_genre);
  assert.equal(
    JSON.stringify(result.metrics).includes("data:image"),
    false,
    "metrics must never carry drawing content",
  );
  const expected = new Map(
    spec.calls.map((call) => [call.id, { model: spec.models[call.model], effort: call.effort }]),
  );
  for (const { callId, request } of requests) {
    const declared = expected.get(callId);
    assert.ok(declared);
    assert.equal(request.model, declared.model);
    assert.equal(request.reasoning?.effort, declared.effort);
    assert.equal(request.safety_identifier, "dry-user-hash");
    const call = spec.calls.find((candidate) => candidate.id === callId);
    assert.ok(call);
    if (call.schema) {
      assert.equal(request.text?.format?.type, "json_schema");
      if (request.text?.format?.type === "json_schema") {
        assert.equal(request.text.format.strict, true);
      }
    }
  }
});

test("photo entry runs P1 before the photo extractor and never runs drawing P2", async () => {
  const order: string[] = [];
  await runPhotoScan(
    { photo: "data:image/jpeg;base64,dry" },
    {
      safetyId: "photo-user-hash",
      dryRun: true,
      onRequest(trace) {
        order.push(trace.callId);
      },
    },
  );
  assert.equal(order[0], "P1");
  assert.ok(order.indexOf("P2_photo") > order.indexOf("P0_calibrate"));
  assert.equal(order.includes("P2"), false);
  assert.ok(order.indexOf("P8") > order.indexOf("P7"));
});

test("dry-run coverage reaches every declared call through its automatic entry point", async () => {
  const seen = new Map<string, { model: string; effort: unknown }>();
  const options = {
    safetyId: "coverage-user-hash",
    dryRun: true as const,
    onRequest(trace: { callId: string; model: string; effort: unknown }) {
      seen.set(trace.callId, { model: trace.model, effort: trace.effort });
    },
  };
  const scan = await runPipeline({ image: "data:image/png;base64,coverage" }, options);
  await runPhotoScan({ photo: "data:image/jpeg;base64,coverage" }, options);
  const edit = await runVoiceEdit(
    { gamespec: scan.gameSpec, utterance: "move slowly" },
    options,
  );
  assert.ok(edit && typeof edit === "object");
  assert.deepEqual((edit as Record<string, unknown>).spec_diff, {});
  assert.equal("spec_diff_json" in (edit as Record<string, unknown>), false);
  await runMultipageStitch(
    { gamespec_existing: scan.gameSpec, image_new: "data:image/png;base64,page-two" },
    options,
  );
  await runShareModeration(
    {
      rendered_game: "data:image/png;base64,render",
      title: "Dry Run",
      playtestReport: scan.playtestReport,
      solvability: scan.solvability,
    },
    options,
  );

  assert.deepEqual([...seen.keys()].sort(), spec.calls.map((call) => call.id).sort());
  for (const call of spec.calls) {
    const trace = seen.get(call.id);
    assert.ok(trace, `${call.id} was not exercised`);
    assert.equal(trace.model, spec.models[call.model]);
    assert.ok(
      new Set([
        call.effort,
        call.escalate_to,
        call.effort_router?.simple,
        call.effort_router?.rich,
      ]).has(trace.effort as never),
      `${call.id} used undeclared effort ${String(trace.effort)}`,
    );
  }
});

test("an uncertain safety result fails closed after its declared escalation", async () => {
  const efforts: unknown[] = [];
  const client: ResponsesClient = {
    responses: {
      async create(request) {
        efforts.push(request.reasoning?.effort);
        return {
          id: `uncertain-${efforts.length}`,
          output_text: JSON.stringify({ verdict: "uncertain", reason_code: "none" }),
          output: [],
        };
      },
    },
  };
  await assert.rejects(
    runPipeline(
      { image: "data:image/png;base64,uncertain" },
      { safetyId: "uncertain-user", client },
    ),
    (error: unknown) => error instanceof PipelineBlocked && error.callId === "P1",
  );
  assert.deepEqual(efforts, ["none", "low"]);
});

test("a disconnect signal reaches the active model request and stops the pipeline", async () => {
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  let calls = 0;
  const client: ResponsesClient = {
    responses: {
      async create(_request, options) {
        calls += 1;
        receivedSignal = options?.signal;
        controller.abort(new Error("client_disconnected"));
        receivedSignal?.throwIfAborted();
        throw new Error("unreachable");
      },
    },
  };

  await assert.rejects(
    runPipeline(
      { image: "data:image/png;base64,disconnect" },
      { safetyId: "disconnect-user", client, signal: controller.signal },
    ),
    /client_disconnected/,
  );
  assert.equal(receivedSignal, controller.signal);
  assert.equal(calls, 1, "no later model call may start after disconnect");
});

test("a malformed safety verdict fails closed before extraction", async () => {
  const calls: string[] = [];
  const client: ResponsesClient = {
    responses: {
      async create() {
        return {
          id: "malformed-safety",
          output_text: JSON.stringify({ verdict: "allow" }),
          output: [],
        };
      },
    },
  };

  await assert.rejects(
    runPipeline(
      { image: "data:image/png;base64,malformed-safety" },
      {
        safetyId: "malformed-safety-user",
        client,
        onRequest(trace) {
          calls.push(trace.callId);
        },
      },
    ),
    (error: unknown) => error instanceof ModelOutputError && error.callId === "P1",
  );
  assert.deepEqual(calls, ["P1"]);
});

test("drawing generation returns original artwork only after the mandatory gates pass", async () => {
  const image = "data:image/png;base64,aGVsbG8=";
  const result = await generateDrawingGame(
    { image, safetyId: SERVICE_SAFETY_ID, context: { capture_surface: "paper" } },
    { dryRun: true },
  );

  assert.equal(result.playableGame.format, "inkling-playable-game-v1");
  assert.equal(result.playableGame.gameSpec, result.scan.gameSpec);
  assert.equal(result.playableGame.artwork?.sourceDataUrl, image);
  assert.deepEqual(
    result.playableGame.artwork?.entityCrops.hero_1?.map((value) => Number(value.toFixed(3))),
    [0.044, 0.538, 0.156, 0.762],
  );
  assert.equal(result.playableGame.artwork?.heroRig?.tier, "squash_stretch_puppet");
  assert.equal(result.playableGame.readinessEvidence?.solvability.verdict, "ready");
  assert.equal(result.playableGame.readinessEvidence?.playtestReport.reached_goal, true);
  assert.equal(result.playableGame.readinessEvidence?.runtimeTraceReport, null);
  assert.equal(result.playableGame.readinessEvidence?.playContract.outcome, "related_fallback");
  assert.ok(
    result.playableGame.readinessEvidence?.playContract.unsupportedCapabilities.includes(
      "dynamic_entity_behavior",
    ),
  );
});

test("drawing generation rejects remote or oversized image input before P1", async () => {
  await assert.rejects(
    generateDrawingGame({ image: "https://example.com/drawing.png", safetyId: SERVICE_SAFETY_ID }),
    /inline GIF, JPEG, PNG, or WebP/,
  );
  await assert.rejects(
    generateDrawingGame(
      { image: "data:image/png;base64,aGVsbG8=", safetyId: SERVICE_SAFETY_ID },
      { maxImageBytes: 1, dryRun: true },
    ),
    /service limit/,
  );
  await assert.rejects(
    generateDrawingGame({ image: "data:image/png;base64,aGVsbG8=", safetyId: "child@example.com" }),
    /privacy-preserving SHA-256 hash/,
  );
});

test("HTTP generation derives safety identity on the server and returns no-store playable games", async () => {
  const handler = createDrawingGenerationHandler({
    dryRun: true,
    resolveSafetyId() {
      return SERVICE_SAFETY_ID;
    },
  });
  const response = await handler(new Request("https://inkling.test/api/games/drawing", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ image: "data:image/png;base64,aGVsbG8=", request_id: REQUEST_ID, safetyId: "do-not-trust-this" }),
  }));
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json() as { requestId?: string; playableGame?: { format?: string } };
  assert.equal(body.requestId, REQUEST_ID);
  assert.equal(body.playableGame?.format, "inkling-playable-game-v1");

  const unbound = await handler(new Request("https://inkling.test/api/games/drawing", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ image: "data:image/png;base64,aGVsbG8=" }),
  }));
  assert.equal(unbound.status, 400);

  const crossOrigin = await handler(new Request("https://inkling.test/api/games/drawing", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://not-inkling.test" },
    body: JSON.stringify({ image: "data:image/png;base64,aGVsbG8=", request_id: REQUEST_ID }),
  }));
  assert.equal(crossOrigin.status, 403);

  const missingSession = createDrawingGenerationHandler({
    dryRun: true,
    resolveSafetyId() {
      return undefined;
    },
  });
  const rejected = await missingSession(new Request("https://inkling.test/api/games/drawing", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ image: "data:image/png;base64,aGVsbG8=", request_id: REQUEST_ID }),
  }));
  assert.equal(rejected.status, 401);
});

test("streaming generation exposes only coarse pipeline stages before its playable result", async () => {
  const qualityRecords: unknown[] = [];
  const handler = createDrawingGenerationStreamHandler({
    dryRun: true,
    resolveSafetyId() {
      return SERVICE_SAFETY_ID;
    },
    onGenerationRecord(record) {
      qualityRecords.push(record);
    },
  });
  const response = await handler(new Request("https://inkling.test/api/games/drawing", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ image: "data:image/png;base64,aGVsbG8=", request_id: REQUEST_ID }),
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const events = (await response.text()).trim().split("\n\n").map((line) => {
    const data = line.slice("data: ".length);
    return JSON.parse(data) as { type: string; requestId?: string; stage?: string; playableGame?: { format?: string } };
  });
  assert.equal(events[0]?.type, "progress");
  assert.equal(events[0]?.stage, "checking");
  assert.ok(events.every((event) => event.requestId === REQUEST_ID));
  assert.ok(events.some((event) => event.stage === "understanding"));
  assert.ok(events.some((event) => event.stage === "animating"));
  assert.ok(events.some((event) => event.stage === "testing"));
  const order = ["checking", "understanding", "animating", "testing"];
  const progress = events.filter((event) => event.type === "progress");
  assert.ok(progress.every((event, index) => (
    index === 0 || order.indexOf(event.stage ?? "") >= order.indexOf(progress[index - 1]?.stage ?? "")
  )));
  assert.equal(events.at(-1)?.type, "complete");
  assert.equal(events.at(-1)?.playableGame?.format, "inkling-playable-game-v1");

  assert.equal(qualityRecords.length, 1, "one operator quality record per generation");
  const record = qualityRecords[0] as Record<string, unknown>;
  assert.equal(record.outcome, "playable");
  assert.equal(record.certification, "not_measured");
  assert.equal(typeof record.playContractOutcome, "string");
  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes("data:image"), false, "no drawing content in operator records");
  assert.equal(serialized.includes(SERVICE_SAFETY_ID), false, "no identity in operator records");
});

test("every few-shot example satisfies the strict contract it teaches", () => {
  const gameSpecSchema = loadJson<SchemaDocument>(root, "spec/schemas/gamespec.json");
  const fewshot = loadJson<Array<{ role: string; content: Array<{ type: string; text: string }> }>>(
    root,
    "spec/fewshot/gamespec_fewshot.json",
  );
  const userTexts = fewshot
    .filter((message) => message.role === "user")
    .map((message) => message.content[0]?.text ?? "");
  for (const lesson of ["classic first scan", "maze", "semantic physics", "handwriting", "absurd"]) {
    assert.ok(
      userTexts.some((text) => text.toLowerCase().includes(lesson)),
      `a "${lesson}" lesson must exist`,
    );
  }

  const assistants = fewshot.filter((message) => message.role === "assistant");
  assert.equal(assistants.length, userTexts.length, "every lesson needs a taught answer");
  for (const [index, message] of assistants.entries()) {
    const spec = JSON.parse(message.content[0]?.text ?? "") as GameSpec;
    const issues = validateJsonSchema(spec, gameSpecSchema.schema);
    assert.deepEqual(issues, [], `example ${index + 1} must validate against the strict GameSpec schema`);

    const ids = [spec.hero.id, ...spec.entities.map((entity) => entity.id)];
    assert.equal(new Set(ids).size, ids.length, `example ${index + 1} ids must be unique`);
    for (const entity of spec.entities) {
      if (entity.linked_to) {
        assert.ok(
          spec.entities.some((other) => other.id === entity.linked_to),
          `example ${index + 1} linked_to must reference a declared entity`,
        );
      }
    }
    if (spec.goal.kind === "reach_goal" || spec.goal.kind === "defeat_boss") {
      const target = spec.entities.find((entity) => entity.id === spec.goal.target_id);
      assert.ok(target, `example ${index + 1} goal target must be a declared entity`);
      const finishRoles = spec.goal.kind === "reach_goal" ? ["goal"] : ["boss"];
      assert.ok(
        finishRoles.includes(target.role),
        `example ${index + 1} goal target role ${target.role} cannot finish ${spec.goal.kind}`,
      );
    } else {
      assert.equal(spec.goal.target_id, null, `example ${index + 1} ${spec.goal.kind} takes no target`);
    }
    assert.equal(
      runPlaytest(spec).reached_goal,
      true,
      `example ${index + 1} must teach a finishable world`,
    );
  }
});

test("pipeline.json cannot declare a field the runner does not consume", () => {
  const raw = loadJson<JsonObject>(root, "spec/pipeline.json");
  validatePipelineSpec(structuredClone(raw));

  const cases: Array<[(doc: JsonObject) => void, string]> = [
    [(doc) => { doc["mystery_field"] = true; }, "top-level"],
    [(doc) => { (doc["globals"] as JsonObject)["cache_stable_prefixes"] = true; }, "globals"],
    [(doc) => { ((doc["calls"] as JsonObject[])[0] as JsonObject)["realtime"] = true; }, "call"],
    [(doc) => { (doc["execution_graph"] as JsonObject)["retry_path"] = []; }, "execution_graph"],
  ];
  for (const [mutate, location] of cases) {
    const mutated = structuredClone(raw);
    mutate(mutated);
    assert.throws(
      () => validatePipelineSpec(mutated),
      /not consumed by the runner/,
      `an unconsumed ${location} field must be rejected`,
    );
  }
});

test("the loader refuses spec changes that would weaken gates, loops, or ordering", () => {
  const raw = loadJson<JsonObject>(root, "spec/pipeline.json");
  const callIn = (doc: JsonObject, id: string): JsonObject =>
    (doc["calls"] as JsonObject[]).find((call) => call["id"] === id) as JsonObject;

  const gateless = structuredClone(raw);
  delete callIn(gateless, "P1")["blocks_pipeline_on"];
  assert.throws(() => validatePipelineSpec(gateless), /gate/);

  const shareGateless = structuredClone(raw);
  delete callIn(shareGateless, "P11")["blocks_pipeline_on"];
  assert.throws(() => validatePipelineSpec(shareGateless), /gate/);

  const unbounded = structuredClone(raw);
  delete callIn(unbounded, "P8")["max_iterations"];
  assert.throws(() => validatePipelineSpec(unbounded), /max_iterations/);

  const badFanOut = structuredClone(raw);
  callIn(badFanOut, "P7")["fan_out_over"] = "gamespec.entities";
  assert.throws(() => validatePipelineSpec(badFanOut), /fan_out_over/);

  const misordered = structuredClone(raw);
  const path = (misordered["execution_graph"] as JsonObject)["scan_path"] as unknown[];
  [path[0], path[1]] = [path[1], path[0]];
  assert.throws(() => validatePipelineSpec(misordered), /before its dependency/);

  const weakenedIdentity = structuredClone(raw);
  (weakenedIdentity["globals"] as JsonObject)["safety_identifier"] = "optional";
  assert.throws(() => validatePipelineSpec(weakenedIdentity), /safety_identifier/);

  const laneEscape = structuredClone(raw);
  callIn(laneEscape, "P10")["validator"] = "headless_sdk_validator";
  assert.throws(() => validatePipelineSpec(laneEscape), /lane B/);
});

test("P7 escalates to its declared effort once before an entity falls back to static", async () => {
  const dynamicSpec = structuredClone(SHAREABLE_GAME_SPEC);
  dynamicSpec.entities.push({
    id: "walker",
    role: "enemy",
    bbox: [0.05, 0.05, 0.12, 0.12],
    behavior: "patrol",
    linked_to: null,
    style_ref: "source",
  });
  let activeCallId = "";
  const p7Efforts: unknown[] = [];
  const client: ResponsesClient = {
    responses: {
      async create() {
        if (activeCallId === "P7") {
          return { id: "mock-P7", output: [] };
        }
        const value = activeCallId === "P1" ? { verdict: "allow", reason_code: "none" }
          : activeCallId === "P0_calibrate" ? { complexity: "simple" }
          : activeCallId === "P2" ? dynamicSpec
          : activeCallId === "P3" ? { topology: "blob", tier: "squash_stretch_puppet", joints: [], animations: ["idle"], style_ref: null }
          : activeCallId === "P4" ? { layers: [{ source: "source-page", parallax: 0.5 }] }
          : activeCallId === "P5" ? { music_pack_id: "base", sfx_pack_id: "base" }
          : activeCallId === "P8" ? { verdict: "ready", repairs: [], fallback: "none" }
          : {};
        return { id: `mock-${activeCallId}`, output_text: JSON.stringify(value), output: [] };
      },
    },
  };
  const result = await runPipeline(
    { image: "data:image/png;base64,ZXNjYWxhdGU=" },
    {
      safetyId: "p7-escalation-user",
      client,
      onRequest(trace, request) {
        activeCallId = trace.callId;
        if (trace.callId === "P7") p7Efforts.push(request.reasoning?.effort);
      },
    },
  );
  assert.deepEqual(
    p7Efforts,
    ["medium", "high"],
    "a fruitless behavior session retries once at the declared escalation effort",
  );
  assert.equal(result.behaviorFallbacks["walker"], "static");
  assert.deepEqual(result.behaviorPatches, []);
});

test("share moderation cannot be reached without passing P8 evidence", async () => {
  const calls: string[] = [];
  await assert.rejects(
    moderateShareCandidate({
      renderedGame: "data:image/png;base64,aGVsbG8=",
      title: "My game",
      playtestReport: { reached_goal: false, first_blocker: "blocked", time_to_win: null, seed: 1, visited: [] },
      solvability: { verdict: "repair" },
      playContract: FAITHFUL_SHARE_CONTRACT,
      runtimeTraceReport: FAITHFUL_RUNTIME_REPORT,
      safetyId: SERVICE_SAFETY_ID,
    }, {
      dryRun: true,
      onRequest(trace) {
        calls.push(trace.callId);
      },
    }),
    /passing P8 evidence/,
  );
  assert.deepEqual(calls, []);

  const verdict = await moderateShareCandidate({
    renderedGame: "data:image/png;base64,aGVsbG8=",
    title: "My game",
    playtestReport: { reached_goal: true, first_blocker: null, time_to_win: 4, seed: 1, visited: ["hero"] },
    solvability: { verdict: "ready" },
    playContract: FAITHFUL_SHARE_CONTRACT,
    runtimeTraceReport: FAITHFUL_RUNTIME_REPORT,
    safetyId: SERVICE_SAFETY_ID,
  }, { dryRun: true });
  assert.equal(verdict.publishable, true);

  const fallbackSpec = structuredClone(SHAREABLE_GAME_SPEC);
  fallbackSpec.primary_genre = "maze";
  const fallbackCalls: string[] = [];
  await assert.rejects(
    moderateShareCandidate({
      renderedGame: "data:image/png;base64,aGVsbG8=",
      title: "A generic fallback",
      playtestReport: { reached_goal: true, first_blocker: null, time_to_win: 4, seed: 1, visited: ["hero"] },
      solvability: { verdict: "ready" },
      playContract: createPlayContract(fallbackSpec),
      runtimeTraceReport: FAITHFUL_RUNTIME_REPORT,
      safetyId: SERVICE_SAFETY_ID,
    }, {
      dryRun: true,
      onRequest(trace) {
        fallbackCalls.push(trace.callId);
      },
    }),
    /faithful runtime PlayContract/,
  );
  assert.deepEqual(fallbackCalls, [], "P11 must not run for a related fallback");

  await assert.rejects(
    moderateShareCandidate({
      renderedGame: "data:image/png;base64,aGVsbG8=",
      title: "No real replay",
      playtestReport: { reached_goal: true, first_blocker: null, time_to_win: 4, seed: 1, visited: ["hero"] },
      solvability: { verdict: "ready" },
      playContract: FAITHFUL_SHARE_CONTRACT,
      runtimeTraceReport: { ...FAITHFUL_RUNTIME_REPORT, valid: false, blockers: ["idle_win"] },
      safetyId: SERVICE_SAFETY_ID,
    }, { dryRun: true }),
    /production-runtime replay receipt/,
  );
});
