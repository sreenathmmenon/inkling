/**
 * REVIEW GATE — CSS cascade architecture.
 *
 * Protects: the client stylesheet stays an ordered, import-only cascade of
 * single-purpose modules, and every cross-module property override (a later
 * module winning over an earlier one purely by import order) is an explicitly
 * reviewed decision recorded in css-override-baseline.json.
 * Why it may not be weakened: an unreviewed override silently changes which
 * module owns a visual property, which is exactly how cascade regressions
 * ship. Legitimate redesigns pass by updating the baseline in the same
 * change, after reviewing the printed selector/property-level diff — never by
 * removing the comparison.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { findProjectRoot } from "../runner/spec.js";

const root = findProjectRoot();
const entryPath = resolve(root, "apps/client/src/styles.css");
const expectedImports = [
  "./styles/00-foundations.css",
  "./styles/10-capture.css",
  "./styles/20-player.css",
  "./styles/30-responsive.css",
  "./styles/40-experience.css",
  "./styles/90-motion-preferences.css",
] as const;

type Rule = {
  context: string;
  selector: string;
  properties: string[];
};

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function matchingBrace(source: string, open: number): number {
  let depth = 1;
  let quote = "";
  for (let index = open + 1; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index;
  }
  throw new Error(`Unclosed CSS block at byte ${open}`);
}

function declarationProperties(body: string): string[] {
  const properties: string[] = [];
  let start = 0;
  let parentheses = 0;
  let quote = "";
  const consume = (end: number) => {
    const declaration = body.slice(start, end).trim();
    const colon = declaration.indexOf(":");
    if (colon > 0) properties.push(declaration.slice(0, colon).trim().toLowerCase());
    start = end + 1;
  };
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]!;
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    else if (character === ";" && parentheses === 0) consume(index);
  }
  consume(body.length);
  return properties;
}

function rulesIn(source: string, context: string[] = []): Rule[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  let statementStart = 0;
  let quote = "";
  for (let index = 0; index < css.length; index += 1) {
    const character = css[index]!;
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ";") {
      statementStart = index + 1;
      continue;
    }
    if (character !== "{") continue;
    const prelude = normalize(css.slice(statementStart, index));
    const close = matchingBrace(css, index);
    const body = css.slice(index + 1, close);
    if (/^@(media|supports|container|layer)\b/.test(prelude)) {
      rules.push(...rulesIn(body, [...context, prelude]));
    } else if (prelude && !prelude.startsWith("@")) {
      const properties = declarationProperties(body);
      rules.push({ context: context.join(" > "), selector: prelude, properties });
    }
    index = close;
    statementStart = close + 1;
  }
  return rules;
}

const entry = await readFile(entryPath, "utf8");
const imports = [...entry.matchAll(/@import\s+["']([^"']+)["']\s*;/g)].map((match) => match[1]!);
assert.deepEqual(imports, expectedImports, "styles.css cascade imports changed order");
assert.equal(new Set(imports).size, imports.length, "styles.css imports a module more than once");
const entryRemainder = entry.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@import\s+["'][^"']+["']\s*;/g, "").trim();
assert.equal(entryRemainder, "", "styles.css must remain an import-only cascade manifest");

const modules = await Promise.all(expectedImports.map(async (relativePath) => {
  const path = resolve(entryPath, "..", relativePath);
  const source = await readFile(path, "utf8");
  assert.equal(/@import\b/.test(source), false, `${basename(path)} must not add nested imports`);
  return { name: basename(path), source, rules: rulesIn(source) };
}));

const owners = new Map<string, Set<string>>();
for (const module of modules) {
  for (const rule of module.rules) {
    for (const property of rule.properties) {
      const key = `${rule.context} :: ${rule.selector} :: ${property}`;
      const modulesForRule = owners.get(key) ?? new Set<string>();
      modulesForRule.add(module.name);
      owners.set(key, modulesForRule);
    }
  }
}
const crossModuleOverrides = [...owners]
  .filter(([, moduleNames]) => moduleNames.size > 1)
  .map(([key, moduleNames]) => `${key} :: ${[...moduleNames].sort().join(",")}`)
  .sort();

// The reviewed overrides live in css-override-baseline.json (each entry is
// "context :: selector :: property :: owning modules"). Any drift fails this
// gate with an entry-level diff so the review happens on the actual selectors
// and properties, not on an opaque fingerprint. After reviewing cascade
// ownership, an intentional change is approved by updating the baseline file
// in the same commit.
const baselinePath = resolve(root, "scripts/css-override-baseline.json");
const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as string[];
assert.ok(Array.isArray(baseline) && baseline.every((entry) => typeof entry === "string"), "css-override-baseline.json must be an array of override entries");
const baselineSet = new Set(baseline);
const currentSet = new Set(crossModuleOverrides);
const added = crossModuleOverrides.filter((entry) => !baselineSet.has(entry));
const removed = baseline.filter((entry) => !currentSet.has(entry));
if (added.length > 0 || removed.length > 0) {
  const explain = (label: string, sign: string, entries: string[]): string => entries.length === 0
    ? ""
    : `\n${label} (${entries.length}):\n${entries.map((entry) => {
      const [context, selector, property, moduleNames] = entry.split(" :: ");
      const where = context ? ` inside ${context}` : "";
      return `  ${sign} ${selector}${where} — property "${property}" now set by [${moduleNames}]`;
    }).join("\n")}`;
  console.error(`After review, the full current override set as baseline JSON:\n${JSON.stringify(crossModuleOverrides, null, 2)}`);
  assert.fail(
    "cross-module CSS overrides changed; review cascade ownership, then update scripts/css-override-baseline.json to approve:" +
    explain("New unapproved overrides", "+", added) +
    explain("Approved overrides no longer present", "-", removed),
  );
}

console.log(`CSS architecture verified: ${modules.length} ordered modules, ${crossModuleOverrides.length} reviewed cross-module overrides.`);
