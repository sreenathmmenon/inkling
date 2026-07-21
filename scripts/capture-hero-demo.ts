/**
 * BUILD TOOL — captures the landing hero-demo assets from the real product.
 *
 * The capture shell's hero demo shows a real corpus drawing materializing into
 * its actual generated game. This script produces those assets honestly: it
 * serves the production client build, opens a saved playable game document in
 * the real player, holds the real movement control, and snapshots the live
 * Phaser canvas while the drawn hero moves. The corpus drawing is downscaled
 * only (pixels pass through a plain canvas resize — never restyled).
 *
 * Usage:
 *   node dist/scripts/capture-hero-demo.js /abs/path/playable-game.json [drawing.png]
 *
 * Outputs (overwrites): apps/client/public/demo/drawing.webp, game-0..3.webp
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import { chromium } from "playwright";

import { findProjectRoot } from "../runner/spec.js";

const root = findProjectRoot();
const clientRoot = resolve(root, "build/client");
const documentPath = process.argv[2];
assert.ok(documentPath, "usage: node dist/scripts/capture-hero-demo.js /abs/path/playable-game.json [drawing.png]");
const drawingPath = process.argv[3] ?? resolve(root, "fixtures/validation-drawings/round-1/01-caterpillar-leaves.png");
const outputDir = resolve(root, "apps/client/public/demo");

function contentType(path: string): string {
  if (extname(path) === ".js") return "text/javascript; charset=utf-8";
  if (extname(path) === ".css") return "text/css; charset=utf-8";
  if (extname(path) === ".woff2") return "font/woff2";
  if (extname(path) === ".webp") return "image/webp";
  return "text/html; charset=utf-8";
}

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const relative = pathname === "/" ? "index.html" : pathname.slice(1);
    const path = resolve(clientRoot, relative);
    assert.ok(path.startsWith(`${clientRoot}/`) || path === resolve(clientRoot, "index.html"));
    response.setHeader("content-type", contentType(path));
    response.end(await readFile(path));
  } catch {
    response.statusCode = 404;
    response.end("Not found");
  }
});

await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
assert.ok(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });

function decodeDataUrl(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(",");
  assert.ok(dataUrl.startsWith("data:image/webp") && comma > 0, "capture did not produce a webp data URL");
  return Buffer.from(dataUrl.slice(comma + 1), "base64");
}

try {
  // The certified-drive lane replays the deterministic solver's own winning
  // InputFrames through the production scene, so the captured loop shows the
  // real game being genuinely won — never a scripted mock or a lost life.
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 }, hasTouch: true });
  await page.goto(`${baseUrl}/?certified-drive`);
  await page.locator("#spec-file").setInputFiles({
    name: "hero-demo-source.json",
    mimeType: "application/json",
    buffer: await readFile(documentPath),
  });
  await page.locator("canvas").waitFor();
  await page.locator("body.playing").waitFor();
  const drive = await page.evaluate(() => (window as typeof window & {
    __INKLING_CERTIFIED_DRIVE__?: { reachedGoal: boolean; timeToWin: number | null };
  }).__INKLING_CERTIFIED_DRIVE__);
  assert.ok(drive?.reachedGoal, `document is not certified-drivable: ${JSON.stringify(drive)}`);
  // Let the reveal settle so frames show the world at rest scale.
  await page.waitForTimeout(1_100);

  const frames: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    await page.waitForTimeout(index === 0 ? 300 : 700);
    frames.push(await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>("#game canvas");
      if (!canvas) throw new Error("player canvas missing");
      const target = document.createElement("canvas");
      target.width = 480;
      target.height = 270;
      const context = target.getContext("2d");
      if (!context) throw new Error("no 2d context");
      context.drawImage(canvas, 0, 0, target.width, target.height);
      return target.toDataURL("image/webp", 0.68);
    }));
  }
  assert.ok(new Set(frames).size >= 2, "captured frames are identical — the hero did not visibly move");

  const drawingSource = await readFile(drawingPath);
  const drawingWebp = await page.evaluate(async (source: string) => {
    const image = new Image();
    await new Promise((resolveLoad, rejectLoad) => {
      image.onload = resolveLoad;
      image.onerror = rejectLoad;
      image.src = source;
    });
    const width = 480;
    const height = Math.round((image.naturalHeight * width) / image.naturalWidth);
    const target = document.createElement("canvas");
    target.width = width;
    target.height = height;
    const context = target.getContext("2d");
    if (!context) throw new Error("no 2d context");
    context.drawImage(image, 0, 0, width, height);
    return target.toDataURL("image/webp", 0.72);
  }, `data:image/png;base64,${drawingSource.toString("base64")}`);

  await mkdir(outputDir, { recursive: true });
  await writeFile(resolve(outputDir, "drawing.webp"), decodeDataUrl(drawingWebp));
  for (const [index, frame] of frames.entries()) {
    await writeFile(resolve(outputDir, `game-${index}.webp`), decodeDataUrl(frame));
  }
  let total = 0;
  for (const name of ["drawing.webp", "game-0.webp", "game-1.webp", "game-2.webp", "game-3.webp"]) {
    const bytes = (await stat(resolve(outputDir, name))).size;
    total += bytes;
    console.log(`${name}: ${bytes} bytes`);
  }
  console.log(`total demo assets: ${total} bytes`);
  await page.close();
} finally {
  await browser.close();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}
