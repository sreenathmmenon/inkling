import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import type { Responses } from "openai/resources/responses/responses";

import {
  ModelOutputError,
  PipelineBlocked,
  runMultipageStitch,
  runPhotoScan,
  runPipeline,
  runShareModeration,
  runVoiceEdit,
} from "../runner/pipeline.js";
import { validateJsonSchema } from "../runner/schema-validation.js";
import { generateDrawingGame } from "../services/gen/src/drawing-service.js";
import {
  createDrawingGenerationHandler,
  createDrawingGenerationStreamHandler,
} from "../services/gen/src/http.js";
import { moderateShareCandidate } from "../services/share/src/share-service.js";
import {
  findProjectRoot,
  loadJson,
  loadPipelineSpec,
  resolveProjectFile,
} from "../runner/spec.js";
import type {
  PipelineCall,
  ResponsesClient,
  SchemaDocument,
} from "../runner/types.js";

const SERVICE_SAFETY_ID = "a".repeat(64);

const root = findProjectRoot();
const spec = loadPipelineSpec(root);

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
  assert.deepEqual(result.playableGame.artwork?.entityCrops.hero_1, [0.05, 0.55, 0.15, 0.75]);
  assert.equal(result.playableGame.artwork?.heroRig?.tier, "squash_stretch_puppet");
  assert.equal(result.playableGame.readinessEvidence?.solvability.verdict, "ready");
  assert.equal(result.playableGame.readinessEvidence?.playtestReport.reached_goal, true);
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
    body: JSON.stringify({ image: "data:image/png;base64,aGVsbG8=", safetyId: "do-not-trust-this" }),
  }));
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json() as { playableGame?: { format?: string } };
  assert.equal(body.playableGame?.format, "inkling-playable-game-v1");

  const crossOrigin = await handler(new Request("https://inkling.test/api/games/drawing", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://not-inkling.test" },
    body: JSON.stringify({ image: "data:image/png;base64,aGVsbG8=" }),
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
    body: JSON.stringify({ image: "data:image/png;base64,aGVsbG8=" }),
  }));
  assert.equal(rejected.status, 401);
});

test("streaming generation exposes only coarse pipeline stages before its playable result", async () => {
  const handler = createDrawingGenerationStreamHandler({
    dryRun: true,
    resolveSafetyId() {
      return SERVICE_SAFETY_ID;
    },
  });
  const response = await handler(new Request("https://inkling.test/api/games/drawing", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ image: "data:image/png;base64,aGVsbG8=" }),
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const events = (await response.text()).trim().split("\n\n").map((line) => {
    const data = line.slice("data: ".length);
    return JSON.parse(data) as { type: string; stage?: string; playableGame?: { format?: string } };
  });
  assert.equal(events[0]?.type, "progress");
  assert.equal(events[0]?.stage, "checking");
  assert.ok(events.some((event) => event.stage === "understanding"));
  assert.ok(events.some((event) => event.stage === "animating"));
  assert.ok(events.some((event) => event.stage === "testing"));
  assert.equal(events.at(-1)?.type, "complete");
  assert.equal(events.at(-1)?.playableGame?.format, "inkling-playable-game-v1");
});

test("share moderation cannot be reached without passing P8 evidence", async () => {
  const calls: string[] = [];
  await assert.rejects(
    moderateShareCandidate({
      renderedGame: "data:image/png;base64,aGVsbG8=",
      title: "My game",
      playtestReport: { reached_goal: false, first_blocker: "blocked", time_to_win: null, seed: 1, visited: [] },
      solvability: { verdict: "repair" },
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
    safetyId: SERVICE_SAFETY_ID,
  }, { dryRun: true });
  assert.equal(verdict.publishable, true);
});
