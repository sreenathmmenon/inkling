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

export function loadPipelineSpec(root = findProjectRoot()): PipelineSpec {
  const spec = loadJson<PipelineSpec>(root, "spec/pipeline.json");
  if (spec.api !== "responses") {
    throw new Error(`Unsupported API surface: ${String(spec.api)}`);
  }
  const ids = new Set<string>();
  for (const call of spec.calls) {
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
  }
  return spec;
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
