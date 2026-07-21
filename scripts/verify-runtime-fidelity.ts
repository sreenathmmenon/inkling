/**
 * REVIEW GATE — game-view fidelity: the child's strokes ARE the game.
 *
 * Protects: "your lines become the game" as a rendered fact. Loads a real
 * corpus drawing + its real P2 GameSpec in the production client and asserts,
 * as properties (never pixel literals):
 *   - every crop-bearing surface renders its own drawn strokes AT its play
 *     rectangle, full opacity, and those pixels agree with the source page's
 *     ink for that region — not with a flat template fill;
 *   - no rendered artwork repaints the source photograph at stale positions
 *     (no near-viewport image, page-context crops stay unrendered, every
 *     artwork image tracks its entity's collision primitive);
 *   - the hero renders at a readable scale and collectibles render their
 *     crops at full opacity behind a gentle affordance, not a gray wash.
 * Why it may not be weakened: these assertions stand between a passing build
 * and a child who sees purple template slabs where their drawing should be.
 * The product promise is visual; only a real-browser render can prove it.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

import { chromium, type Browser } from "playwright";

import { createArtworkManifest } from "../packages/runtime/src/artwork.js";
import {
  createPlatformerPlan,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  type PlannedEntity,
} from "../packages/runtime/src/platformer-layout.js";
import { HERO_READABLE_MIN_DIMENSION } from "../packages/runtime/src/presentation-contract.js";
import { findProjectRoot } from "../runner/spec.js";
import type { GameSpec } from "../runner/types.js";

const root = findProjectRoot();
const clientRoot = resolve(root, "build/client");

const gameSpec = JSON.parse(
  await readFile(resolve(root, "tests/fixtures/jungle-explorer-p2.json"), "utf8"),
) as GameSpec;
const drawingBytes = await readFile(
  resolve(root, "fixtures/validation-drawings/round-1/09-jungle-explorer.png"),
);
const sourceDataUrl = `data:image/png;base64,${drawingBytes.toString("base64")}`;
const artwork = createArtworkManifest(gameSpec, sourceDataUrl);
const playableDocument = {
  format: "inkling-playable-game-v1",
  gameSpec,
  artwork,
  readinessEvidence: null,
};
const plan = createPlatformerPlan(gameSpec);

const drawnSurfaces = [
  ...plan.platforms.filter((entity) => entity.artworkSource === "drawing"),
  ...plan.waterVolumes.filter((entity) => entity.artworkSource === "drawing"),
];
assert.ok(drawnSurfaces.length >= 5, "corpus fixture must exercise several drawn surfaces");
assert.ok(plan.collectibles.length >= 3, "corpus fixture must exercise collectibles");

/** Decorations too broad to be sprites must never repaint the photograph. */
const pageContextIds = plan.decorations
  .filter((entity) => {
    const crop = artwork.entityCrops[entity.id];
    if (!crop) return false;
    return (crop[2] - crop[0]) * (crop[3] - crop[1]) >= 0.16;
  })
  .map((entity) => entity.id);
assert.ok(pageContextIds.length >= 1, "corpus fixture must include a page-context crop");

function contentType(path: string): string {
  if (extname(path) === ".js") return "text/javascript; charset=utf-8";
  if (extname(path) === ".css") return "text/css; charset=utf-8";
  if (extname(path) === ".woff2") return "font/woff2";
  return "text/html; charset=utf-8";
}

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = resolve(clientRoot, relative);
  if (target !== clientRoot && !target.startsWith(`${clientRoot}${sep}`)) {
    response.writeHead(400).end();
    return;
  }
  try {
    const bytes = await readFile(target);
    response.writeHead(200, { "content-type": contentType(target), "cache-control": "no-store" });
    response.end(bytes);
  } catch {
    response.writeHead(404).end();
  }
});

await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
assert.ok(address && typeof address === "object");

async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true });
  } catch (firstError) {
    try {
      return await chromium.launch({ channel: "chrome", headless: true });
    } catch {
      throw firstError;
    }
  }
}

interface ProbedObject {
  type: string;
  textureKey: string | null;
  entityId: string | null;
  presentation: string | null;
  x: number;
  y: number;
  displayWidth: number;
  displayHeight: number;
  alpha: number;
  fillAlpha: number | null;
  visible: boolean;
}

interface ProbedBand {
  entityId: string;
  inkFraction: number;
  sourceInkFraction: number;
  templateFraction: number;
  inkMatchFraction: number;
}

const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, hasTouch: true });
  await page.goto(`http://127.0.0.1:${address.port}/?fidelity-probe`);
  await page.locator("#spec-file").setInputFiles({
    name: "fidelity-corpus-game.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(playableDocument)),
  });
  await page.locator("#game canvas").waitFor({ timeout: 45_000 });
  await page.locator("body.playing").waitFor({ timeout: 45_000 });
  await page.waitForFunction(() => {
    const game = window.__INKLING_FIDELITY_GAME__ as {
      scene?: { scenes?: Array<{ children?: { list?: unknown[] } }> };
    } | undefined;
    return Boolean(game?.scene?.scenes?.[0]?.children?.list && game.scene.scenes[0].children.list.length > 10);
  }, undefined, { timeout: 45_000 });
  // Let the reveal settle and the first fixed-step frames render.
  await page.waitForTimeout(900);

  const objects = await page.evaluate(() => {
    const game = window.__INKLING_FIDELITY_GAME__ as {
      scene: { scenes: Array<{ children: { list: unknown[] } }> };
    };
    const scene = game.scene.scenes[0];
    if (!scene) throw new Error("no live scene");
    return scene.children.list.map((child) => {
      const object = child as {
        type: string;
        texture?: { key?: string };
        x: number;
        y: number;
        displayWidth?: number;
        displayHeight?: number;
        alpha: number;
        fillAlpha?: number;
        visible: boolean;
        getData?: (key: string) => unknown;
      };
      const data = (key: string): string | null => {
        const value = object.getData?.(key);
        return typeof value === "string" ? value : null;
      };
      return {
        type: object.type,
        textureKey: object.texture?.key ?? null,
        entityId: data("entityId"),
        presentation: data("inklingPresentation"),
        x: object.x,
        y: object.y,
        displayWidth: object.displayWidth ?? 0,
        displayHeight: object.displayHeight ?? 0,
        alpha: object.alpha,
        fillAlpha: typeof object.fillAlpha === "number" ? object.fillAlpha : null,
        visible: object.visible,
      };
    });
  }) as ProbedObject[];

  const artworkImages = objects.filter((object) => (
    object.type === "Image" &&
    typeof object.textureKey === "string" &&
    (object.textureKey.startsWith("inkling-art-crop-") || object.textureKey === "inkling-original-art")
  ));
  assert.ok(artworkImages.length >= 10, "the corpus world must render child artwork");

  // --- No stale-position source overlay -------------------------------------
  const worldArea = WORLD_WIDTH * WORLD_HEIGHT;
  for (const image of artworkImages) {
    assert.ok(
      image.displayWidth * image.displayHeight < worldArea * 0.45,
      `artwork ${image.entityId ?? image.textureKey} repaints the source page ` +
        `(${Math.round(image.displayWidth)}x${Math.round(image.displayHeight)})`,
    );
  }
  for (const pageContextId of pageContextIds) {
    assert.ok(
      !artworkImages.some((image) => image.entityId === pageContextId),
      `page-context crop ${pageContextId} must not render as an entity`,
    );
  }
  // Every artwork image tracks its entity's collision primitive: the strokes
  // may never sit at a position that disagrees with the geometry in play.
  const shapesByEntity = new Map(objects
    .filter((object) => object.type === "Rectangle" && object.entityId)
    .map((object) => [object.entityId as string, object]));
  for (const image of artworkImages) {
    const shape = image.entityId ? shapesByEntity.get(image.entityId) : undefined;
    if (!shape) continue;
    assert.ok(
      Math.abs(image.x - shape.x) <= 2 && Math.abs(image.y - shape.y) <= 2,
      `artwork ${image.entityId} sits at (${image.x},${image.y}) but its ` +
        `collision primitive is at (${shape.x},${shape.y})`,
    );
  }

  // --- Surfaces render their strokes at their play rectangle ---------------
  for (const surface of drawnSurfaces) {
    const image = artworkImages.find((candidate) => candidate.entityId === surface.id);
    assert.ok(image, `drawn surface ${surface.id} has no rendered artwork`);
    assert.ok(image.visible && image.alpha >= 0.9, `surface ${surface.id} artwork is not full opacity`);
    assert.ok(
      Math.abs(image.x - surface.x) <= 2 && Math.abs(image.y - surface.y) <= 2 &&
        Math.abs(image.displayWidth - surface.width) <= 3 &&
        Math.abs(image.displayHeight - surface.height) <= 3,
      `surface ${surface.id} artwork does not cover its play rectangle`,
    );
  }

  // --- Hero readable, collectibles inviting --------------------------------
  const heroImage = artworkImages.find((image) => image.entityId === plan.hero.id);
  assert.ok(heroImage, "hero artwork missing");
  assert.ok(
    Math.min(heroImage.displayWidth, heroImage.displayHeight) >= HERO_READABLE_MIN_DIMENSION * 0.9,
    `hero renders at ${Math.round(heroImage.displayWidth)}x${Math.round(heroImage.displayHeight)}, ` +
      `below the readable minimum ${HERO_READABLE_MIN_DIMENSION}`,
  );
  const halosByEntity = new Map(objects
    .filter((object) => object.presentation === "artwork-legibility-halo" && object.entityId)
    .map((object) => [object.entityId as string, object]));
  for (const collectible of plan.collectibles) {
    const image = artworkImages.find((candidate) => candidate.entityId === collectible.id);
    assert.ok(image, `collectible ${collectible.id} has no rendered artwork`);
    assert.ok(image.alpha >= 0.9, `collectible ${collectible.id} artwork is washed out (alpha ${image.alpha})`);
    const halo = halosByEntity.get(collectible.id);
    assert.ok(halo, `collectible ${collectible.id} has no affordance`);
    assert.ok(
      (halo.fillAlpha ?? 1) <= 0.12,
      `collectible ${collectible.id} affordance is a wash (fill alpha ${halo.fillAlpha})`,
    );
  }

  // --- Rendered surface pixels agree with the source page's ink ------------
  const platformBands = plan.platforms
    .filter((entity) => entity.artworkSource === "drawing")
    .map((entity) => ({
      entityId: entity.id,
      left: entity.x - entity.width / 2,
      top: entity.y - entity.height / 2,
      width: entity.width,
      height: entity.height,
    }));
  const bands = await page.evaluate(async (input) => {
    const canvas = document.querySelector<HTMLCanvasElement>("#game canvas");
    if (!canvas) throw new Error("player canvas missing");
    const frame = document.createElement("canvas");
    frame.width = input.worldWidth;
    frame.height = input.worldHeight;
    const frameContext = frame.getContext("2d", { willReadFrequently: true });
    if (!frameContext) throw new Error("no 2d context");
    frameContext.drawImage(canvas, 0, 0, frame.width, frame.height);

    const sourceImage = new Image();
    await new Promise((resolveLoad, rejectLoad) => {
      sourceImage.onload = resolveLoad;
      sourceImage.onerror = rejectLoad;
      sourceImage.src = input.sourceDataUrl;
    });

    const quantize = (red: number, green: number, blue: number): number => (
      ((red >> 5) << 10) | ((green >> 5) << 5) | (blue >> 5)
    );
    const modalColor = (data: Uint8ClampedArray): [number, number, number] => {
      const counts = new Map<number, { count: number; red: number; green: number; blue: number }>();
      for (let offset = 0; offset < data.length; offset += 16) {
        const red = data[offset] ?? 0;
        const green = data[offset + 1] ?? 0;
        const blue = data[offset + 2] ?? 0;
        const key = quantize(red, green, blue);
        const bucket = counts.get(key) ?? { count: 0, red: 0, green: 0, blue: 0 };
        bucket.count += 1;
        bucket.red += red;
        bucket.green += green;
        bucket.blue += blue;
        counts.set(key, bucket);
      }
      const top = [...counts.values()].sort((a, b) => b.count - a.count)[0];
      if (!top) return [255, 255, 255];
      return [top.red / top.count, top.green / top.count, top.blue / top.count];
    };
    const distance = (
      red: number, green: number, blue: number,
      [otherRed, otherGreen, otherBlue]: [number, number, number],
    ): number => Math.hypot(red - otherRed, green - otherGreen, blue - otherBlue);

    const worldBackground = modalColor(
      frameContext.getImageData(0, 0, frame.width, frame.height).data,
    );
    const sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = 480;
    sourceCanvas.height = Math.max(1, Math.round((sourceImage.naturalHeight * 480) / sourceImage.naturalWidth));
    const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
    if (!sourceContext) throw new Error("no source context");
    sourceContext.drawImage(sourceImage, 0, 0, sourceCanvas.width, sourceCanvas.height);
    const pageBackground = modalColor(
      sourceContext.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height).data,
    );

    const results: Array<{
      entityId: string;
      inkFraction: number;
      sourceInkFraction: number;
      templateFraction: number;
      inkMatchFraction: number;
    }> = [];
    for (const band of input.bands) {
      const inset = 4;
      const x = Math.max(0, Math.round(band.left) + inset);
      const y = Math.max(0, Math.round(band.top) + inset);
      const width = Math.min(frame.width - x, Math.round(band.width) - inset * 2);
      const height = Math.min(frame.height - y, Math.round(band.height) - inset * 2);
      if (width < 4 || height < 4) continue;
      const rendered = frameContext.getImageData(x, y, width, height).data;

      // The same page region, resampled from the original drawing.
      const bandCanvas = document.createElement("canvas");
      bandCanvas.width = width;
      bandCanvas.height = height;
      const bandContext = bandCanvas.getContext("2d", { willReadFrequently: true });
      if (!bandContext) throw new Error("no band context");
      bandContext.drawImage(
        sourceImage,
        (x / input.worldWidth) * sourceImage.naturalWidth,
        (y / input.worldHeight) * sourceImage.naturalHeight,
        (width / input.worldWidth) * sourceImage.naturalWidth,
        (height / input.worldHeight) * sourceImage.naturalHeight,
        0,
        0,
        width,
        height,
      );
      const sourceBand = bandContext.getImageData(0, 0, width, height).data;

      const sourceClusters = new Map<number, { count: number; red: number; green: number; blue: number }>();
      let sourceInk = 0;
      let sourceSamples = 0;
      for (let offset = 0; offset < sourceBand.length; offset += 4) {
        const red = sourceBand[offset] ?? 0;
        const green = sourceBand[offset + 1] ?? 0;
        const blue = sourceBand[offset + 2] ?? 0;
        sourceSamples += 1;
        if (distance(red, green, blue, pageBackground) <= 48) continue;
        sourceInk += 1;
        const key = quantize(red, green, blue);
        const bucket = sourceClusters.get(key) ?? { count: 0, red: 0, green: 0, blue: 0 };
        bucket.count += 1;
        bucket.red += red;
        bucket.green += green;
        bucket.blue += blue;
        sourceClusters.set(key, bucket);
      }
      const inkCenters = [...sourceClusters.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, 8)
        .map((bucket) => [bucket.red / bucket.count, bucket.green / bucket.count, bucket.blue / bucket.count] as [number, number, number]);

      let ink = 0;
      let matched = 0;
      let template = 0;
      let samples = 0;
      for (let offset = 0; offset < rendered.length; offset += 4) {
        const red = rendered[offset] ?? 0;
        const green = rendered[offset + 1] ?? 0;
        const blue = rendered[offset + 2] ?? 0;
        samples += 1;
        if (distance(red, green, blue, input.templateViolet as [number, number, number]) <= 28) template += 1;
        if (distance(red, green, blue, worldBackground) <= 40) continue;
        ink += 1;
        if (inkCenters.some((center) => distance(red, green, blue, center) <= 64)) matched += 1;
      }
      results.push({
        entityId: band.entityId,
        inkFraction: samples > 0 ? ink / samples : 0,
        sourceInkFraction: sourceSamples > 0 ? sourceInk / sourceSamples : 0,
        templateFraction: samples > 0 ? template / samples : 0,
        inkMatchFraction: ink > 0 ? matched / ink : 1,
      });
    }
    return results;
  }, {
    bands: platformBands,
    worldWidth: WORLD_WIDTH,
    worldHeight: WORLD_HEIGHT,
    sourceDataUrl,
    templateViolet: [0x6f, 0x5b, 0xe7],
  }) as ProbedBand[];

  assert.ok(bands.length >= 5, "too few measurable surface bands");
  for (const band of bands) {
    assert.ok(
      band.templateFraction < 0.3,
      `surface ${band.entityId} is dominated by the template fill (${band.templateFraction.toFixed(2)})`,
    );
    if (band.sourceInkFraction >= 0.08) {
      assert.ok(
        band.inkFraction >= Math.min(0.03, band.sourceInkFraction * 0.25),
        `surface ${band.entityId} shows almost no drawn ink ` +
          `(rendered ${band.inkFraction.toFixed(3)}, source ${band.sourceInkFraction.toFixed(3)})`,
      );
    }
    if (band.inkFraction >= 0.05) {
      assert.ok(
        band.inkMatchFraction >= 0.5,
        `surface ${band.entityId} ink does not match the child's page colors ` +
          `(match ${band.inkMatchFraction.toFixed(2)})`,
      );
    }
  }
  const inkyBands = bands.filter((band) => band.inkFraction >= 0.05);
  assert.ok(
    inkyBands.length >= Math.ceil(bands.length * 0.6),
    `only ${inkyBands.length}/${bands.length} surfaces visibly carry the child's strokes`,
  );

  console.log(
    `runtime fidelity OK: ${artworkImages.length} artwork images, ` +
      `${bands.length} surface bands (ink ${bands.map((band) => band.inkFraction.toFixed(2)).join("/")}), ` +
      `hero ${Math.round(heroImage.displayWidth)}x${Math.round(heroImage.displayHeight)}`,
  );
  await page.close();
} finally {
  await browser.close();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}
