import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  PipelineCall,
  PipelineSpec,
  SchemaDocument,
} from "./types.js";

function hasPipelineSpec(path: string): boolean {
  return existsSync(join(path, "spec", "pipeline.json"));
}

export function findProjectRoot(start = process.cwd()): string {
  let current = resolve(start);
  while (true) {
    if (hasPipelineSpec(current)) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  current = moduleDirectory;
  while (true) {
    if (hasPipelineSpec(current)) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error("Unable to locate spec/pipeline.json");
}

export function resolveProjectFile(root: string, path: string): string {
  if (isAbsolute(path)) throw new Error(`Spec path must be relative: ${path}`);
  const resolved = resolve(root, path);
  const outside = relative(root, resolved);
  if (outside === ".." || outside.startsWith(`..${sep}`) || isAbsolute(outside)) {
    throw new Error(`Spec path escapes project root: ${path}`);
  }
  return resolved;
}

export function loadText(root: string, path: string): string {
  return readFileSync(resolveProjectFile(root, path), "utf8");
}

export function loadJson<T>(root: string, path: string): T {
  return JSON.parse(loadText(root, path)) as T;
}

// Every field below is genuinely consumed by the runner. The loader rejects
// anything else so a declared-but-unread field cannot exist: adding spec
// vocabulary requires teaching the executor what it means in the same change.
// "$comment" and execution_graph "notes" are the only prose-documentation
// exceptions and carry no behavior.
export const CONSUMED_TOP_LEVEL_FIELDS = new Set([
  "$comment",
  "version",
  "api",
  "globals",
  "models",
  "calls",
  "execution_graph",
]);
export const CONSUMED_GLOBAL_FIELDS = new Set([
  "reasoning_mode_live",
  "reasoning_mode_offline",
  "text_verbosity_json",
  "text_verbosity_by_model",
  "safety_identifier",
]);
export const CONSUMED_CALL_FIELDS = new Set([
  "id",
  "name",
  "model",
  "effort",
  "escalate_to",
  "lane",
  "input",
  "prompt",
  "schema",
  "fewshot",
  "tools",
  "validator",
  "depends_on",
  "blocks_pipeline_on",
  "parallel_group",
  "optional",
  "run_if",
  "loop_until",
  "max_iterations",
  "fan_out_over",
  "then",
  "hard_requires",
  "effort_router",
]);
export const CONSUMED_EXECUTION_GRAPH_FIELDS = new Set(["scan_path", "notes"]);

export const FAN_OUT_PATTERN = /^[\w.]+\[\]\.\w+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyConsumedFields(
  value: Record<string, unknown>,
  consumed: ReadonlySet<string>,
  location: string,
): void {
  for (const key of Object.keys(value)) {
    if (!consumed.has(key)) {
      throw new Error(
        `${location}.${key} is declared in pipeline.json but not consumed by the runner`,
      );
    }
  }
}

export function validatePipelineSpec(document: unknown): PipelineSpec {
  if (!isRecord(document)) throw new Error("pipeline.json must be an object");
  assertOnlyConsumedFields(document, CONSUMED_TOP_LEVEL_FIELDS, "pipeline");
  const spec = document as unknown as PipelineSpec;
  if (spec.api !== "responses") {
    throw new Error(`Unsupported API surface: ${String(spec.api)}`);
  }
  if (typeof spec.version !== "string" || !/^\d+\.\d+\.\d+$/.test(spec.version)) {
    throw new Error(`pipeline.json version must be semantic: ${String(spec.version)}`);
  }
  if (!isRecord(spec.globals)) throw new Error("pipeline.globals must be an object");
  assertOnlyConsumedFields(
    spec.globals as unknown as Record<string, unknown>,
    CONSUMED_GLOBAL_FIELDS,
    "globals",
  );
  if (spec.globals.safety_identifier !== "REQUIRED_PER_USER_HASH") {
    throw new Error("globals.safety_identifier may not weaken the per-user hash requirement");
  }
  const verbosityByModel = spec.globals.text_verbosity_by_model;
  if (verbosityByModel !== undefined) {
    if (!isRecord(verbosityByModel)) {
      throw new Error("globals.text_verbosity_by_model must map model aliases to verbosity");
    }
    for (const [alias, verbosity] of Object.entries(verbosityByModel)) {
      if (!spec.models[alias]) {
        throw new Error(`text_verbosity_by_model references unknown model alias ${alias}`);
      }
      if (verbosity !== "low" && verbosity !== "medium" && verbosity !== "high") {
        throw new Error(`text_verbosity_by_model.${alias} must be low, medium, or high`);
      }
    }
  }
  if (!Array.isArray(spec.calls) || spec.calls.length === 0) {
    throw new Error("pipeline.calls must be a non-empty array");
  }

  const ids = new Set<string>();
  for (const call of spec.calls) {
    assertOnlyConsumedFields(
      call as unknown as Record<string, unknown>,
      CONSUMED_CALL_FIELDS,
      `calls.${call.id ?? "?"}`,
    );
    if (ids.has(call.id)) throw new Error(`Duplicate call id: ${call.id}`);
    ids.add(call.id);
    if (!spec.models[call.model]) {
      throw new Error(`${call.id} references unknown model alias ${call.model}`);
    }
    if (call.then && !spec.models[call.then]) {
      throw new Error(`${call.id} references unknown then-model alias ${call.then}`);
    }
  }
  for (const call of spec.calls) {
    for (const dependency of call.depends_on) {
      if (!ids.has(dependency)) {
        throw new Error(`${call.id} depends on unknown call ${dependency}`);
      }
    }
    for (const requirement of call.hard_requires ?? []) {
      if (!ids.has(requirement)) {
        throw new Error(`${call.id} hard_requires unknown call ${requirement}`);
      }
    }
    // A gate that declares no blocking or loop rule would silently stop
    // gating; refuse the configuration instead of running it.
    if (call.lane === "gate" && !call.blocks_pipeline_on && !call.loop_until) {
      throw new Error(`${call.id} is a gate but declares no blocks_pipeline_on or loop_until`);
    }
    if (call.blocks_pipeline_on && !isRecord(call.blocks_pipeline_on)) {
      throw new Error(`${call.id} blocks_pipeline_on must be an object`);
    }
    if ((call.tools || call.validator) && call.lane !== "B") {
      throw new Error(`${call.id} declares Lane B tools/validator outside lane B`);
    }
    if (call.fan_out_over !== undefined) {
      if (!FAN_OUT_PATTERN.test(call.fan_out_over)) {
        throw new Error(`${call.id} fan_out_over must look like path.to.items[].field`);
      }
      if (call.parallel_group === null) {
        throw new Error(`${call.id} fans out but is not in a parallel_group`);
      }
    }
    if (call.loop_until !== undefined) {
      if (typeof call.max_iterations !== "number" || call.max_iterations < 1) {
        throw new Error(`${call.id} loop_until requires max_iterations >= 1`);
      }
    }
    if (call.effort_router && !ids.has(call.effort_router.call)) {
      throw new Error(`${call.id} effort_router references unknown call ${call.effort_router.call}`);
    }
  }

  const graph = spec.execution_graph;
  if (!isRecord(graph) || !Array.isArray(graph.scan_path)) {
    throw new Error("pipeline.execution_graph.scan_path must be an array");
  }
  assertOnlyConsumedFields(
    graph as unknown as Record<string, unknown>,
    CONSUMED_EXECUTION_GRAPH_FIELDS,
    "execution_graph",
  );
  const byId = new Map(spec.calls.map((call) => [call.id, call]));
  const position = new Map<string, number>();
  const groupsInPath = new Set<string>();
  for (const [index, step] of graph.scan_path.entries()) {
    if (typeof step === "string") {
      if (!byId.has(step)) throw new Error(`execution_graph step ${step} is not a declared call`);
      position.set(step, index);
      continue;
    }
    if (!isRecord(step) || typeof step.parallel !== "string") {
      throw new Error("execution_graph steps must be call ids or {parallel: group}");
    }
    const members = spec.calls.filter((call) => call.parallel_group === step.parallel);
    if (members.length === 0) {
      throw new Error(`execution_graph parallel group ${step.parallel} has no calls`);
    }
    groupsInPath.add(step.parallel);
    for (const member of members) position.set(member.id, index);
  }
  for (const call of spec.calls) {
    if (call.parallel_group !== null && !groupsInPath.has(call.parallel_group)) {
      throw new Error(`${call.id} parallel_group ${call.parallel_group} never appears in execution_graph`);
    }
    const pos = position.get(call.id);
    if (pos === undefined) continue;
    for (const dependency of call.depends_on) {
      const dependencyPosition = position.get(dependency);
      if (dependencyPosition === undefined || dependencyPosition >= pos) {
        throw new Error(
          `execution_graph orders ${call.id} before its dependency ${dependency}`,
        );
      }
    }
  }
  return spec;
}

export function loadPipelineSpec(root = findProjectRoot()): PipelineSpec {
  return validatePipelineSpec(loadJson<unknown>(root, "spec/pipeline.json"));
}

export function callMap(spec: PipelineSpec): Map<string, PipelineCall> {
  return new Map(spec.calls.map((call) => [call.id, call]));
}

export function loadSchema(
  root: string,
  call: PipelineCall,
): SchemaDocument | undefined {
  if (!call.schema) return undefined;
  const document = loadJson<SchemaDocument>(root, call.schema);
  if (document.strict !== true) {
    throw new Error(`${call.id} schema must declare strict: true`);
  }
  return document;
}
