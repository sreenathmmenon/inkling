/**
 * REVIEW GATE — capture-shell / player chunk boundary.
 *
 * Protects: the capture shell boots without Phaser — the entry chunk stays
 * small and the deterministic player stays a lazy chunk never referenced by
 * the capture HTML (AGENTS.md §3: the player is a lazy chunk).
 * Why it may not be weakened: an eager or bloated entry silently breaks
 * camera-first mobile boot. Runs against a build it triggers itself (via the
 * npm script), never a stale dist/.
 */
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { findProjectRoot } from "../runner/spec.js";

const root = findProjectRoot();
const clientRoot = resolve(root, "build/client");
const html = await readFile(resolve(clientRoot, "index.html"), "utf8");
const entryPath = html.match(/<script[^>]+src="\/(assets\/index-[^"]+\.js)"/)?.[1];
assert.ok(entryPath, "production client has no hashed entry script");

const entryBytes = (await stat(resolve(clientRoot, entryPath))).size;
assert.ok(
  entryBytes <= 100 * 1024,
  `capture entry is ${entryBytes} bytes; Phaser/runtime must remain lazy (limit 102400)`,
);

const assets = await readdir(resolve(clientRoot, "assets"));
const playerChunk = assets.find((name) => /^platformer-.*\.js$/.test(name));
assert.ok(playerChunk, "production build has no lazy deterministic player chunk");
assert.equal(html.includes(playerChunk), false, "player chunk is eagerly referenced by capture HTML");

console.log(
  `Client bundle boundary passed: capture entry ${(entryBytes / 1024).toFixed(1)} KiB; ` +
  `player is lazy in ${playerChunk}.`,
);
