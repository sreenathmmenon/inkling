import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const overrideFingerprint = createHash("sha256").update(crossModuleOverrides.join("\n")).digest("hex");
// These are the reviewed overrides created by responsive sizing and the final
// experience-polish pass. Any new cross-module property collision must be
// reviewed explicitly instead of silently relying on import order.
const expectedOverrideFingerprint = "22b227fa2bd5141b5f502ceec18f7db7db41ec37e160a573c88dcf506d458feb";
assert.equal(
  overrideFingerprint,
  expectedOverrideFingerprint,
  `cross-module CSS overrides changed; review cascade ownership before updating the fingerprint:\n${crossModuleOverrides.join("\n")}`,
);

console.log(`CSS architecture verified: ${modules.length} ordered modules, ${crossModuleOverrides.length} reviewed cross-module overrides.`);
