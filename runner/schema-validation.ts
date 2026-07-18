import type { JsonObject } from "./types.js";

export interface SchemaValidationIssue {
  path: string;
  message: string;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function displayType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Validates the JSON Schema subset used by Inkling's strict response schemas.
 * This is defense in depth: Structured Outputs remains the primary API
 * guarantee, while this prevents malformed mocks, proxies, or future client
 * changes from influencing a gate or GameSpec.
 */
export function validateJsonSchema(
  value: unknown,
  schema: unknown,
  path = "$",
): SchemaValidationIssue[] {
  if (!isRecord(schema)) {
    return [{ path, message: "schema node must be an object" }];
  }

  const issues: SchemaValidationIssue[] = [];
  const rawTypes = schema.type;
  const types = Array.isArray(rawTypes)
    ? rawTypes.filter((type): type is string => typeof type === "string")
    : typeof rawTypes === "string"
      ? [rawTypes]
      : [];
  if (types.length > 0 && !types.some((type) => matchesType(value, type))) {
    issues.push({
      path,
      message: `expected ${types.join("|")}, received ${displayType(value)}`,
    });
    return issues;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((item) => sameJsonValue(item, value))) {
    issues.push({ path, message: "value is not in enum" });
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      issues.push({ path, message: `must be at least ${schema.minimum}` });
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      issues.push({ path, message: `must be at most ${schema.maximum}` });
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      issues.push({ path, message: `must contain at least ${schema.minItems} items` });
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      issues.push({ path, message: `must contain at most ${schema.maxItems} items` });
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => {
        issues.push(...validateJsonSchema(item, schema.items, `${path}[${index}]`));
      });
    }
  }

  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === "string")
      : [];
    for (const key of required) {
      if (!(key in value)) issues.push({ path: `${path}.${key}`, message: "is required" });
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          issues.push({ path: `${path}.${key}`, message: "additional property is not allowed" });
        }
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (key in value) {
        issues.push(...validateJsonSchema(value[key], propertySchema, `${path}.${key}`));
      }
    }
  }

  return issues;
}
