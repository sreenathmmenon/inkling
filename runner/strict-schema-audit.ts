import { pathToFileURL } from "node:url";

import {
  findProjectRoot,
  loadJson,
  loadPipelineSpec,
} from "./spec.js";
import type { JsonObject, SchemaDocument } from "./types.js";

export interface StrictSchemaIssue {
  schemaPath: string;
  jsonPath: string;
  message: string;
}

function objectType(schema: JsonObject): boolean {
  return schema.type === "object" ||
    (Array.isArray(schema.type) && schema.type.includes("object"));
}

function arrayType(schema: JsonObject): boolean {
  return schema.type === "array" ||
    (Array.isArray(schema.type) && schema.type.includes("array"));
}

function auditNode(
  schemaPath: string,
  schema: unknown,
  jsonPath: string,
  issues: StrictSchemaIssue[],
): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  const node = schema as JsonObject;
  if (objectType(node)) {
    if (node.additionalProperties !== false) {
      issues.push({
        schemaPath,
        jsonPath,
        message: "objects used with strict Structured Outputs require additionalProperties:false",
      });
    }
    const properties =
      node.properties && typeof node.properties === "object" && !Array.isArray(node.properties)
        ? (node.properties as JsonObject)
        : {};
    const required = new Set(Array.isArray(node.required) ? node.required : []);
    for (const [key, property] of Object.entries(properties)) {
      if (!required.has(key)) {
        issues.push({
          schemaPath,
          jsonPath: `${jsonPath}.${key}`,
          message: "all fields used with strict Structured Outputs must be required",
        });
      }
      auditNode(schemaPath, property, `${jsonPath}.${key}`, issues);
    }
  }
  if (arrayType(node)) {
    auditNode(schemaPath, node.items, `${jsonPath}[]`, issues);
  }
  if (Array.isArray(node.anyOf)) {
    node.anyOf.forEach((branch, index) =>
      auditNode(schemaPath, branch, `${jsonPath}.anyOf[${index}]`, issues),
    );
  }
  if (node.$defs && typeof node.$defs === "object" && !Array.isArray(node.$defs)) {
    for (const [key, definition] of Object.entries(node.$defs as JsonObject)) {
      auditNode(schemaPath, definition, `${jsonPath}.$defs.${key}`, issues);
    }
  }
}

export function auditOpenAIStrictSchemas(root = findProjectRoot()): StrictSchemaIssue[] {
  const spec = loadPipelineSpec(root);
  const schemaPaths = new Set(
    spec.calls.flatMap((call) => (call.schema ? [call.schema] : [])),
  );
  const issues: StrictSchemaIssue[] = [];
  for (const schemaPath of schemaPaths) {
    const document = loadJson<SchemaDocument>(root, schemaPath);
    if (document.strict !== true) {
      issues.push({
        schemaPath,
        jsonPath: "$",
        message: "schema wrapper must declare strict:true",
      });
    }
    auditNode(schemaPath, document.schema, "$", issues);
  }
  return issues;
}

function runCli(): void {
  const issues = auditOpenAIStrictSchemas();
  if (issues.length === 0) {
    console.log("All response schemas satisfy the OpenAI strict subset.");
    return;
  }
  console.error(`Found ${issues.length} OpenAI strict-schema incompatibilities:`);
  for (const issue of issues) {
    console.error(`  ${issue.schemaPath} ${issue.jsonPath}: ${issue.message}`);
  }
  process.exitCode = 1;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) runCli();
