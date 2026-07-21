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

// The landing hero demo stays out of the boot path: its module is a lazy
// chunk never referenced by the capture HTML, and its captured drawing/game
// assets stay within an explicit weight budget so the loop never competes
// with the capture shell for first paint.
const demoChunk = assets.find((name) => /^hero-demo-.*\.js$/.test(name));
assert.ok(demoChunk, "production build has no lazy hero-demo chunk");
assert.equal(html.includes(demoChunk), false, "hero demo chunk is eagerly referenced by capture HTML");
const demoAssets = (await readdir(resolve(clientRoot, "demo"))).filter((name) => name.endsWith(".webp"));
assert.ok(
  demoAssets.includes("drawing.webp") && demoAssets.some((name) => /^game-\d+\.webp$/.test(name)),
  `hero demo assets are missing from the build: ${JSON.stringify(demoAssets)}`,
);
let demoBytes = 0;
for (const name of demoAssets) demoBytes += (await stat(resolve(clientRoot, "demo", name))).size;
assert.ok(demoBytes <= 300 * 1024, `hero demo assets are ${demoBytes} bytes; the landing loop budget is 307200`);

console.log(
  `Client bundle boundary passed: capture entry ${(entryBytes / 1024).toFixed(1)} KiB; ` +
  `player is lazy in ${playerChunk}; hero demo is lazy in ${demoChunk} ` +
  `with ${(demoBytes / 1024).toFixed(1)} KiB of captured assets.`,
);
