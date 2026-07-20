import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import { chromium, type Page } from "playwright";

import { findProjectRoot } from "../runner/spec.js";

const root = findProjectRoot();
const clientRoot = resolve(root, "build/client");

function contentType(path: string): string {
  if (extname(path) === ".js") return "text/javascript; charset=utf-8";
  if (extname(path) === ".css") return "text/css; charset=utf-8";
  if (extname(path) === ".woff2") return "font/woff2";
  return "text/html; charset=utf-8";
}

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const relative = pathname === "/" ? "index.html" : pathname.slice(1);
    const path = resolve(clientRoot, relative);
    assert.ok(path.startsWith(`${clientRoot}/`) || path === resolve(clientRoot, "index.html"));
    response.setHeader("content-type", contentType(path));
    response.setHeader("cache-control", "no-store");
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

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  assert.ok(dimensions.scroll <= dimensions.client + 1, `horizontal overflow: ${JSON.stringify(dimensions)}`);
}

try {
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
    { width: 1366, height: 768 },
  ]) {
    const page = await browser.newPage({ viewport });
    await page.goto(baseUrl);
    await assertNoHorizontalOverflow(page);
    const primary = await page.locator(".choose-action").boundingBox();
    assert.ok(primary && primary.width >= 48 && primary.height >= 48, `capture target is too small at ${viewport.width}x${viewport.height}`);
    await page.close();
  }

  const capture = await browser.newPage({ viewport: { width: 390, height: 844 } });
  let releaseGeneration: (() => void) | undefined;
  await capture.route("**/api/games/drawing", async (route) => {
    await new Promise<void>((resolveRoute) => { releaseGeneration = resolveRoute; });
    await route.abort("aborted").catch(() => undefined);
  });
  await capture.goto(baseUrl);
  await capture.locator("#drawing-file").setInputFiles(resolve(root, "fixtures/validation-drawings/round-1/03-crayon-maze.png"));
  await capture.locator("body.capture-ready").waitFor();
  await capture.waitForFunction(() => {
    const rect = document.querySelector("#make-game")!.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= innerHeight;
  });
  const make = await capture.locator("#make-game").boundingBox();
  assert.ok(make && make.y + make.height <= 844, "review CTA is below the mobile viewport");
  await capture.locator("#make-game").click();
  await capture.locator("body.generating").waitFor();
  await capture.waitForFunction(() => {
    const previewRect = document.querySelector(".preview-stage")!.getBoundingClientRect();
    const progressRect = document.querySelector("#progress-panel")!.getBoundingClientRect();
    return previewRect.top >= 0 && previewRect.bottom <= innerHeight && progressRect.top >= 0 && progressRect.top < innerHeight;
  });
  const progress = await capture.locator("#progress-panel").boundingBox();
  const preview = await capture.locator(".preview-stage").boundingBox();
  const cancel = await capture.locator("#cancel-generation").boundingBox();
  assert.ok(preview && preview.y >= 0 && preview.y + preview.height <= 844, "drawing is not visible during generation");
  assert.ok(progress && progress.y >= 0 && progress.y < 844, "real progress is not visible during generation");
  assert.ok(cancel && cancel.y >= 0 && cancel.y + cancel.height <= 844, "generation recovery is not visible");
  await capture.locator("#cancel-generation").click();
  releaseGeneration?.();
  await capture.close();

  const landscapeReview = await browser.newPage({ viewport: { width: 844, height: 390 }, hasTouch: true });
  await landscapeReview.goto(baseUrl);
  await landscapeReview.locator("#drawing-file").setInputFiles(resolve(root, "fixtures/validation-drawings/round-1/03-crayon-maze.png"));
  await landscapeReview.locator("body.capture-ready").waitFor();
  const landscapeReviewLayout = await landscapeReview.evaluate(() => {
    const make = document.querySelector<HTMLElement>("#make-game")!.getBoundingClientRect();
    const preview = document.querySelector<HTMLElement>(".preview-stage")!.getBoundingClientRect();
    return {
      make: { top: make.top, bottom: make.bottom, width: make.width, height: make.height },
      preview: { top: preview.top, bottom: preview.bottom },
      viewport: { width: innerWidth, height: innerHeight },
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  assert.ok(landscapeReviewLayout.make.top >= 0 && landscapeReviewLayout.make.bottom <= landscapeReviewLayout.viewport.height, `landscape review CTA is clipped: ${JSON.stringify(landscapeReviewLayout)}`);
  assert.ok(landscapeReviewLayout.make.width >= 48 && landscapeReviewLayout.make.height >= 48, `landscape review CTA is too small: ${JSON.stringify(landscapeReviewLayout)}`);
  assert.ok(landscapeReviewLayout.preview.top >= 0 && landscapeReviewLayout.preview.top < landscapeReviewLayout.viewport.height, `landscape review hides the drawing: ${JSON.stringify(landscapeReviewLayout)}`);
  assert.ok(landscapeReviewLayout.overflow <= 1, `landscape review has horizontal overflow: ${JSON.stringify(landscapeReviewLayout)}`);
  await landscapeReview.close();

  const lowContrastSurface = await browser.newPage({ viewport: { width: 844, height: 844 } });
  await lowContrastSurface.goto(baseUrl);
  await lowContrastSurface.locator("#drawing-file").setInputFiles(resolve(root, "fixtures/validation-drawings/round-1/06-frog-lilypad.png"));
  await lowContrastSurface.locator("body.capture-ready").waitFor();
  const preparedSurface = await lowContrastSurface.locator("#drawing-preview").evaluate((preview: HTMLImageElement) => ({
    width: preview.naturalWidth,
    height: preview.naturalHeight,
  }));
  assert.ok(preparedSurface.width < 1_000 && preparedSurface.height < 1_450, `low-contrast drawing surface was not cropped before upload: ${JSON.stringify(preparedSurface)}`);
  assert.ok(preparedSurface.width > 700 && preparedSurface.height > 1_100, `surface crop removed too much child artwork: ${JSON.stringify(preparedSurface)}`);
  await lowContrastSurface.close();

  const recastDecision = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await recastDecision.goto(baseUrl);
  await recastDecision.evaluate(() => {
    document.body.classList.add("recast", "has-drawing");
    document.querySelector<HTMLElement>("#recast-panel")!.hidden = false;
  });
  assert.equal(await recastDecision.locator(".capture-action-zone").isVisible(), false, "recast decision retains a stale Make my game action");
  assert.equal(await recastDecision.locator("#recast-panel").isVisible(), true, "recast decision is hidden");
  await recastDecision.close();

  const malformed = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await malformed.goto(baseUrl);
  await malformed.locator("#spec-file").setInputFiles({
    name: "not-a-game.json",
    mimeType: "application/json",
    buffer: Buffer.from("{not json}"),
  });
  await malformed.locator("#capture-status").getByText("That saved game could not be opened", { exact: false }).waitFor();
  assert.equal(await malformed.locator("#capture-status").isVisible(), true, "saved-game error is hidden");
  await malformed.close();

  const gameSpec = JSON.parse(await readFile(resolve(root, "examples/live-scan-gamespec.json"), "utf8")) as Record<string, unknown>;
  const fourWayGameSpec = structuredClone(gameSpec);
  fourWayGameSpec.primary_genre = "maze";
  fourWayGameSpec.hero = {
    ...(fourWayGameSpec.hero as Record<string, unknown>),
    bbox: [0.08, 0.42, 0.18, 0.58],
  };
  fourWayGameSpec.entities = [{
    id: "four_way_goal",
    role: "goal",
    bbox: [0.72, 0.42, 0.8, 0.58],
    behavior: "static",
    linked_to: null,
    style_ref: "source",
  }];
  fourWayGameSpec.goal = { kind: "reach_goal", target_id: "four_way_goal" };
  const actionGameSpec = structuredClone(gameSpec);
  actionGameSpec.primary_genre = "shooter";
  actionGameSpec.hero = {
    ...(actionGameSpec.hero as Record<string, unknown>),
    bbox: [0.08, 0.42, 0.18, 0.58],
  };
  actionGameSpec.entities = [{
    id: "action_target",
    role: "boss",
    bbox: [0.72, 0.35, 0.82, 0.58],
    behavior: "shooter",
    linked_to: null,
    style_ref: "source",
  }];
  actionGameSpec.goal = { kind: "defeat_boss", target_id: "action_target" };
  const controlViewports = [
    { width: 320, height: 568 },
    { width: 360, height: 640 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
    { width: 768, height: 1024 },
    { width: 1366, height: 768 },
  ];

  // Cross every control contract with every production viewport class. This
  // prevents a generated genre from exposing a layout combination that only
  // worked for the sample used by an earlier regression.
  for (const viewport of controlViewports) {
    for (const contract of [
      { id: "side", spec: gameSpec, minimumButtons: 3 },
      { id: "four-way", spec: fourWayGameSpec, minimumButtons: 4 },
      { id: "four-way-action", spec: actionGameSpec, minimumButtons: 5 },
    ]) {
      const matrixPage = await browser.newPage({ viewport, hasTouch: true });
      await matrixPage.goto(baseUrl);
      await matrixPage.locator("#spec-file").setInputFiles({
        name: `${contract.id}-${viewport.width}x${viewport.height}.json`,
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(contract.spec)),
      });
      await matrixPage.locator("canvas").waitFor();
      const measurement = await matrixPage.evaluate(() => {
        const shell = document.querySelector<HTMLElement>("#game-shell")!.getBoundingClientRect();
        const controls = document.querySelector<HTMLElement>("#accessible-controls")!;
        const controlRect = controls.getBoundingClientRect();
        const buttons = Array.from(controls.querySelectorAll<HTMLElement>("button:not([hidden])")).map((button) => {
          const rect = button.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height };
        }).filter((button) => button.width > 0 && button.height > 0);
        return {
          layout: controls.dataset.layout,
          hasAction: controls.dataset.hasAction,
          shell: { top: shell.top, bottom: shell.bottom, left: shell.left, right: shell.right },
          controls: { top: controlRect.top, bottom: controlRect.bottom, left: controlRect.left, right: controlRect.right },
          buttons,
          viewport: { width: innerWidth, height: innerHeight },
          horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
      assert.ok(measurement.shell.top >= 0 && measurement.shell.bottom <= viewport.height + 1 && measurement.shell.left >= 0 && measurement.shell.right <= viewport.width + 1, `control matrix game is clipped for ${contract.id}@${viewport.width}x${viewport.height}: ${JSON.stringify(measurement)}`);
      assert.ok(measurement.controls.top >= 0 && measurement.controls.bottom <= viewport.height + 1 && measurement.controls.left >= 0 && measurement.controls.right <= viewport.width + 1, `control matrix is clipped for ${contract.id}@${viewport.width}x${viewport.height}: ${JSON.stringify(measurement)}`);
      assert.ok(measurement.buttons.length >= contract.minimumButtons && measurement.buttons.every((button) => button.width >= 48 && button.height >= 48 && button.top >= 0 && button.bottom <= viewport.height && button.left >= 0 && button.right <= viewport.width), `control matrix targets are incomplete for ${contract.id}@${viewport.width}x${viewport.height}: ${JSON.stringify(measurement)}`);
      assert.ok(measurement.horizontalOverflow <= 1, `control matrix overflows horizontally for ${contract.id}@${viewport.width}x${viewport.height}: ${JSON.stringify(measurement)}`);
      if (contract.id === "side") assert.equal(measurement.layout, "side");
      else assert.equal(measurement.layout, "four-way");
      if (contract.id === "four-way-action") assert.equal(measurement.hasAction, "true");
      await matrixPage.close();
    }
  }

  const assistMatrix: Array<{
    page: Page;
    id: string;
    viewport: { width: number; height: number };
  }> = [];
  for (const viewport of controlViewports) {
    for (const contract of [
      { id: "side", spec: gameSpec },
      { id: "four-way-action", spec: actionGameSpec },
    ]) {
      const page = await browser.newPage({ viewport, hasTouch: true });
      await page.goto(baseUrl);
      await page.locator("#spec-file").setInputFiles({
        name: `assist-${contract.id}-${viewport.width}x${viewport.height}.json`,
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(contract.spec)),
      });
      await page.locator("canvas").waitFor();
      if (contract.id === "four-way-action" && viewport.width === 390 && viewport.height === 844) {
        await page.locator("#fullscreen-game").click();
        await page.waitForFunction(() => document.fullscreenElement?.id === "play-stage");
      }
      await page.locator('[data-game-control="left"]').dispatchEvent("pointerdown", {
        pointerId: 70 + assistMatrix.length,
        pointerType: "touch",
      });
      assistMatrix.push({ page, id: contract.id, viewport });
    }
  }
  await Promise.all(assistMatrix.map(({ page }) => page.waitForTimeout(10_500)));
  for (const [index, entry] of assistMatrix.entries()) {
    await entry.page.locator('[data-game-control="left"]').dispatchEvent("pointerup", {
      pointerId: 70 + index,
      pointerType: "touch",
    });
    const assist = entry.page.getByRole("button", { name: "Give me a boost" });
    await assist.waitFor({ state: "visible" });
    const measurement = await entry.page.evaluate(() => {
      const assistRect = document.querySelector<HTMLElement>("#assist-game")!.getBoundingClientRect();
      const controlsRect = document.querySelector<HTMLElement>("#accessible-controls")!.getBoundingClientRect();
      const overlap = !(
        assistRect.right <= controlsRect.left ||
        assistRect.left >= controlsRect.right ||
        assistRect.bottom <= controlsRect.top ||
        assistRect.top >= controlsRect.bottom
      );
      return {
        assist: { top: assistRect.top, bottom: assistRect.bottom, left: assistRect.left, right: assistRect.right, width: assistRect.width, height: assistRect.height },
        controls: { top: controlsRect.top, bottom: controlsRect.bottom, left: controlsRect.left, right: controlsRect.right },
        viewport: { width: innerWidth, height: innerHeight },
        overlap,
      };
    });
    assert.ok(measurement.assist.width >= 48 && measurement.assist.height >= 48 && measurement.assist.top >= 0 && measurement.assist.bottom <= entry.viewport.height && measurement.assist.left >= 0 && measurement.assist.right <= entry.viewport.width, `assist matrix is unreachable for ${entry.id}@${entry.viewport.width}x${entry.viewport.height}: ${JSON.stringify(measurement)}`);
    assert.equal(measurement.overlap, false, `assist overlaps controls for ${entry.id}@${entry.viewport.width}x${entry.viewport.height}: ${JSON.stringify(measurement)}`);
    await assist.click();
    assert.match(await entry.page.locator("#game-status").textContent() ?? "", /Help boost on/, `assist did not activate for ${entry.id}@${entry.viewport.width}x${entry.viewport.height}`);
    await entry.page.close();
  }

  const shortPhone = await browser.newPage({ viewport: { width: 320, height: 568 }, hasTouch: true });
  await shortPhone.goto(baseUrl);
  await shortPhone.locator("#spec-file").setInputFiles({
    name: "short-phone-related-fallback.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      format: "inkling-playable-game-v1",
      gameSpec,
      readinessEvidence: { playContract: { outcome: "related_fallback" } },
    })),
  });
  await shortPhone.locator("canvas").waitFor();
  const shortPhoneLayout = await shortPhone.evaluate(() => {
    const shell = document.querySelector<HTMLElement>("#game-shell")!.getBoundingClientRect();
    const controls = document.querySelector<HTMLElement>("#accessible-controls")!.getBoundingClientRect();
    const buttons = Array.from(document.querySelectorAll<HTMLElement>("#accessible-controls button:not([hidden])")).map((button) => {
      const rect = button.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    });
    const newDrawing = document.querySelector<HTMLElement>(".new-drawing-action")!.getBoundingClientRect();
    return {
      shell: { top: shell.top, bottom: shell.bottom },
      controls: { top: controls.top, bottom: controls.bottom },
      viewportHeight: innerHeight,
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      newDrawing: { width: newDrawing.width, height: newDrawing.height },
      buttons,
    };
  });
  assert.ok(shortPhoneLayout.shell.top >= 0 && shortPhoneLayout.shell.bottom <= shortPhoneLayout.viewportHeight, `short-phone game is outside the initial viewport: ${JSON.stringify(shortPhoneLayout)}`);
  assert.ok(shortPhoneLayout.controls.top >= 0 && shortPhoneLayout.controls.bottom <= shortPhoneLayout.viewportHeight, `short-phone controls are clipped: ${JSON.stringify(shortPhoneLayout)}`);
  assert.ok(shortPhoneLayout.buttons.length >= 3 && shortPhoneLayout.buttons.every((button) => button.width >= 48 && button.height >= 48 && button.top >= 0 && button.bottom <= shortPhoneLayout.viewportHeight), `short-phone touch targets are incomplete: ${JSON.stringify(shortPhoneLayout)}`);
  assert.ok(shortPhoneLayout.newDrawing.width >= 48 && shortPhoneLayout.newDrawing.height >= 48, `short-phone New drawing target is too small: ${JSON.stringify(shortPhoneLayout)}`);
  assert.ok(shortPhoneLayout.horizontalOverflow <= 1, `short-phone play mode overflows horizontally: ${JSON.stringify(shortPhoneLayout)}`);
  const shortPhoneRight = shortPhone.locator('[data-game-control="right"]');
  await shortPhoneRight.dispatchEvent("pointerdown", { pointerId: 40, pointerType: "touch" });
  await shortPhone.waitForTimeout(6_500);
  await shortPhoneRight.dispatchEvent("pointerup", { pointerId: 40, pointerType: "touch" });
  await shortPhone.locator("body.game-won").waitFor();
  const shortPhoneTerminal = await shortPhone.evaluate(() => {
    const shell = document.querySelector<HTMLElement>("#game-shell")!.getBoundingClientRect();
    const status = document.querySelector<HTMLElement>("#game-status")!.getBoundingClientRect();
    return {
      scrollHeight: document.documentElement.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      viewportHeight: innerHeight,
      activeId: (document.activeElement as HTMLElement | null)?.id,
      shell: { top: shell.top, bottom: shell.bottom, left: shell.left, right: shell.right },
      status: { top: status.top, bottom: status.bottom, left: status.left, right: status.right, width: status.width, height: status.height },
      actions: Array.from(document.querySelectorAll<HTMLElement>("#post-play-actions button:not([hidden])")).map((button) => {
      const rect = button.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      }).filter((button) => button.width > 0 && button.height > 0),
    };
  });
  assert.ok(shortPhoneTerminal.scrollHeight <= shortPhoneTerminal.viewportHeight + 1, `short-phone terminal page scrolls: ${JSON.stringify(shortPhoneTerminal)}`);
  assert.ok(shortPhoneTerminal.scrollWidth <= shortPhoneTerminal.clientWidth + 1, `short-phone terminal overflows horizontally: ${JSON.stringify(shortPhoneTerminal)}`);
  assert.ok(shortPhoneTerminal.actions.length >= 3 && shortPhoneTerminal.actions.every((button) => button.top >= 0 && button.bottom <= shortPhoneTerminal.viewportHeight && button.width >= 48 && button.height >= 48), `short-phone terminal actions are clipped: ${JSON.stringify(shortPhoneTerminal)}`);
  assert.ok(shortPhoneTerminal.status.width > 0 && shortPhoneTerminal.status.height > 0 && shortPhoneTerminal.status.top >= shortPhoneTerminal.shell.top && shortPhoneTerminal.status.bottom <= shortPhoneTerminal.shell.bottom && shortPhoneTerminal.status.left >= shortPhoneTerminal.shell.left && shortPhoneTerminal.status.right <= shortPhoneTerminal.shell.right, `short-phone terminal message is clipped: ${JSON.stringify(shortPhoneTerminal)}`);
  assert.equal(shortPhoneTerminal.activeId, "restart", `short-phone terminal focus is not on Play again: ${JSON.stringify(shortPhoneTerminal)}`);
  await shortPhone.close();

  const shortFourWay = await browser.newPage({ viewport: { width: 320, height: 568 }, hasTouch: true });
  await shortFourWay.goto(baseUrl);
  await shortFourWay.locator("#spec-file").setInputFiles({
    name: "short-phone-four-way.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fourWayGameSpec)),
  });
  await shortFourWay.locator("canvas").waitFor();
  const shortFourWayLayout = await shortFourWay.evaluate(() => {
    const shell = document.querySelector<HTMLElement>("#game-shell")!.getBoundingClientRect();
    const controls = document.querySelector<HTMLElement>("#accessible-controls")!;
    const controlRect = controls.getBoundingClientRect();
    const buttons = Array.from(controls.querySelectorAll<HTMLElement>("button:not([hidden])")).map((button) => {
      const rect = button.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    });
    return {
      layout: controls.dataset.layout,
      shell: { top: shell.top, bottom: shell.bottom },
      controls: { top: controlRect.top, bottom: controlRect.bottom },
      viewportHeight: innerHeight,
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      buttons,
    };
  });
  assert.equal(shortFourWayLayout.layout, "four-way", "short-phone four-way contract was not exercised");
  assert.ok(shortFourWayLayout.shell.top >= 0 && shortFourWayLayout.shell.bottom <= shortFourWayLayout.viewportHeight, `short-phone four-way game is clipped: ${JSON.stringify(shortFourWayLayout)}`);
  assert.ok(shortFourWayLayout.controls.top >= 0 && shortFourWayLayout.controls.bottom <= shortFourWayLayout.viewportHeight, `short-phone four-way controls are clipped: ${JSON.stringify(shortFourWayLayout)}`);
  assert.ok(shortFourWayLayout.buttons.length >= 4 && shortFourWayLayout.buttons.every((button) => button.width >= 48 && button.height >= 48 && button.bottom <= shortFourWayLayout.viewportHeight), `short-phone four-way targets are incomplete: ${JSON.stringify(shortFourWayLayout)}`);
  assert.ok(shortFourWayLayout.horizontalOverflow <= 1, `short-phone four-way play overflows horizontally: ${JSON.stringify(shortFourWayLayout)}`);
  const shortFourWayLeft = shortFourWay.locator('[data-game-control="left"]');
  await shortFourWayLeft.dispatchEvent("pointerdown", { pointerId: 41, pointerType: "touch" });
  await shortFourWay.waitForTimeout(10_500);
  await shortFourWayLeft.dispatchEvent("pointerup", { pointerId: 41, pointerType: "touch" });
  const shortFourWayAssist = await shortFourWay.getByRole("button", { name: "Give me a boost" }).boundingBox();
  assert.ok(shortFourWayAssist && shortFourWayAssist.width >= 48 && shortFourWayAssist.height >= 48 && shortFourWayAssist.y >= 0 && shortFourWayAssist.y + shortFourWayAssist.height <= 568, `short-phone four-way help is unreachable: ${JSON.stringify(shortFourWayAssist)}`);
  await shortFourWay.getByRole("button", { name: "Give me a boost" }).click();
  assert.match(await shortFourWay.locator("#game-status").textContent() ?? "", /Help boost on/);
  await shortFourWay.close();

  const desktopPlay = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await desktopPlay.goto(baseUrl);
  await desktopPlay.locator("#spec-file").setInputFiles({
    name: "desktop-game.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(gameSpec)),
  });
  await desktopPlay.locator("canvas").waitFor();
  const desktopShell = await desktopPlay.locator("#game-shell").boundingBox();
  assert.ok(desktopShell && desktopShell.y >= 0 && desktopShell.y + desktopShell.height <= 768, `desktop game is below the initial viewport: ${JSON.stringify(desktopShell)}`);
  assert.ok(await desktopPlay.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), "desktop play mode overflows horizontally");
  await desktopPlay.locator("canvas").click();
  await desktopPlay.keyboard.down("ArrowRight");
  await desktopPlay.waitForTimeout(6_500);
  await desktopPlay.keyboard.up("ArrowRight");
  await desktopPlay.locator("body.game-won").waitFor();
  const desktopTerminal = await desktopPlay.evaluate(() => {
    const shell = document.querySelector<HTMLElement>("#game-shell")!.getBoundingClientRect();
    const status = document.querySelector<HTMLElement>("#game-status")!.getBoundingClientRect();
    return {
      scrollHeight: document.documentElement.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      viewportHeight: innerHeight,
      activeId: (document.activeElement as HTMLElement | null)?.id,
      shell: { top: shell.top, bottom: shell.bottom, left: shell.left, right: shell.right },
      status: { top: status.top, bottom: status.bottom, left: status.left, right: status.right, width: status.width, height: status.height },
      actions: Array.from(document.querySelectorAll<HTMLElement>("#post-play-actions button:not([hidden])")).map((button) => {
      const rect = button.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      }).filter((button) => button.width > 0 && button.height > 0),
    };
  });
  assert.ok(desktopTerminal.scrollHeight <= desktopTerminal.viewportHeight + 1, `desktop terminal page scrolls: ${JSON.stringify(desktopTerminal)}`);
  assert.ok(desktopTerminal.scrollWidth <= desktopTerminal.clientWidth + 1, `desktop terminal overflows horizontally: ${JSON.stringify(desktopTerminal)}`);
  assert.ok(desktopTerminal.actions.length >= 3 && desktopTerminal.actions.every((button) => button.top >= 0 && button.bottom <= desktopTerminal.viewportHeight && button.width >= 48 && button.height >= 48), `desktop terminal actions are below the initial viewport: ${JSON.stringify(desktopTerminal)}`);
  assert.ok(desktopTerminal.status.width > 0 && desktopTerminal.status.height > 0 && desktopTerminal.status.top >= desktopTerminal.shell.top && desktopTerminal.status.bottom <= desktopTerminal.shell.bottom && desktopTerminal.status.left >= desktopTerminal.shell.left && desktopTerminal.status.right <= desktopTerminal.shell.right, `desktop terminal message is clipped: ${JSON.stringify(desktopTerminal)}`);
  assert.equal(desktopTerminal.activeId, "restart", `desktop terminal focus is not on Play again: ${JSON.stringify(desktopTerminal)}`);
  await desktopPlay.close();

  for (const viewport of [
    { width: 768, height: 1024 },
    { width: 820, height: 1180 },
    { width: 1180, height: 820 },
  ]) {
    const tablet = await browser.newPage({ viewport, hasTouch: true });
    await tablet.goto(baseUrl);
    await tablet.locator("#spec-file").setInputFiles({
      name: "tablet-game.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(gameSpec)),
    });
    await tablet.locator("canvas").waitFor();
    assert.equal(await tablet.locator("body.touch-controls").count(), 1, `touch capability was missed at ${viewport.width}x${viewport.height}`);
    assert.equal(await tablet.locator("#accessible-controls").isVisible(), true, `touch controls are hidden at ${viewport.width}x${viewport.height}`);
    const tabletControl = await tablet.locator('[data-game-control="right"]').boundingBox();
    assert.ok(tabletControl && tabletControl.width >= 48 && tabletControl.height >= 48, `tablet control is too small at ${viewport.width}x${viewport.height}`);
    await tablet.close();
  }

  const landscapeTouch = await browser.newPage({ viewport: { width: 844, height: 390 }, hasTouch: true });
  await landscapeTouch.goto(baseUrl);
  await landscapeTouch.locator("#spec-file").setInputFiles({
    name: "landscape-touch-game.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fourWayGameSpec)),
  });
  await landscapeTouch.locator("canvas").waitFor();
  const landscapeLayout = await landscapeTouch.evaluate(() => {
    const controls = document.querySelector<HTMLElement>("#accessible-controls")!;
    const shell = document.querySelector<HTMLElement>("#game-shell")!;
    const controlRect = controls.getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();
    const buttons = Array.from(controls.querySelectorAll<HTMLElement>("button:not([hidden])")).map((button) => {
      const rect = button.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    });
    return {
      controls: { left: controlRect.left, top: controlRect.top, right: controlRect.right, bottom: controlRect.bottom },
      shellBottom: shellRect.bottom,
      position: getComputedStyle(controls).position,
      layout: controls.dataset.layout,
      viewport: { width: innerWidth, height: innerHeight },
      buttons,
    };
  });
  assert.equal(landscapeLayout.position, "fixed", "short-landscape touch controls are not overlaid on the game");
  assert.equal(landscapeLayout.layout, "four-way", "short-landscape did not exercise four-way controls");
  assert.ok(landscapeLayout.controls.left >= 0 && landscapeLayout.controls.top >= 0, `landscape controls start outside the viewport: ${JSON.stringify(landscapeLayout)}`);
  assert.ok(landscapeLayout.controls.right <= landscapeLayout.viewport.width && landscapeLayout.controls.bottom <= landscapeLayout.viewport.height, `landscape controls fall outside the viewport: ${JSON.stringify(landscapeLayout)}`);
  assert.ok(landscapeLayout.shellBottom <= landscapeLayout.viewport.height + 1, `landscape game falls below the viewport: ${JSON.stringify(landscapeLayout)}`);
  assert.ok(await landscapeTouch.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), "landscape play mode overflows horizontally");
  assert.ok(landscapeLayout.buttons.length >= 4 && landscapeLayout.buttons.every((button) => button.width >= 48 && button.height >= 48 && button.bottom <= landscapeLayout.viewport.height), `landscape touch targets are unavailable: ${JSON.stringify(landscapeLayout)}`);
  const landscapeRows = [...new Set(landscapeLayout.buttons.map((button) => button.top))].sort((left, right) => left - right);
  assert.ok(landscapeRows.length >= 2 && landscapeRows[1]! - landscapeRows[0]! >= 55, `landscape four-way rows are crowded: ${JSON.stringify(landscapeLayout)}`);
  const landscapeRight = landscapeTouch.locator('[data-game-control="right"]');
  await landscapeRight.focus();
  await landscapeRight.dispatchEvent("pointerdown", { pointerId: 50, pointerType: "touch" });
  await landscapeTouch.waitForTimeout(6_500);
  await landscapeRight.dispatchEvent("pointerup", { pointerId: 50, pointerType: "touch" });
  await landscapeTouch.locator("body.game-won").waitFor();
  assert.equal(await landscapeTouch.locator("#accessible-controls").isVisible(), false, "landscape win leaves focused movement controls visible");
  const landscapeReplay = await landscapeTouch.getByRole("button", { name: "Play again" }).boundingBox();
  assert.ok(landscapeReplay && landscapeReplay.y >= 0 && landscapeReplay.y + landscapeReplay.height <= 390 && landscapeReplay.width >= 48 && landscapeReplay.height >= 48, `landscape win hides replay outside the viewport: ${JSON.stringify(landscapeReplay)}`);
  const landscapeActions = await landscapeTouch.locator("#post-play-actions button:not([hidden])").evaluateAll((buttons) => buttons
    .map((button) => button.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .map((rect) => ({ top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height })));
  assert.ok(landscapeActions.length >= 3 && landscapeActions.every((button) => button.top >= 0 && button.bottom <= 390 && button.width >= 48 && button.height >= 48), `landscape terminal actions are clipped: ${JSON.stringify(landscapeActions)}`);
  const landscapeTerminal = await landscapeTouch.locator(".play-meta").boundingBox();
  assert.ok(landscapeTerminal && landscapeTerminal.y >= 0 && landscapeTerminal.y + landscapeTerminal.height <= 390, `landscape terminal card is clipped: ${JSON.stringify(landscapeTerminal)}`);
  const landscapeDocumentHeight = await landscapeTouch.evaluate(() => document.documentElement.scrollHeight);
  assert.ok(landscapeDocumentHeight <= 391, `landscape terminal page scrolls: ${landscapeDocumentHeight}px`);
  const landscapeTerminalState = await landscapeTouch.evaluate(() => {
    const shell = document.querySelector<HTMLElement>("#game-shell")!.getBoundingClientRect();
    const status = document.querySelector<HTMLElement>("#game-status")!.getBoundingClientRect();
    return {
      activeId: (document.activeElement as HTMLElement | null)?.id,
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      shell: { top: shell.top, bottom: shell.bottom, left: shell.left, right: shell.right },
      status: { top: status.top, bottom: status.bottom, left: status.left, right: status.right, width: status.width, height: status.height },
    };
  });
  assert.ok(landscapeTerminalState.status.width > 0 && landscapeTerminalState.status.height > 0 && landscapeTerminalState.status.top >= landscapeTerminalState.shell.top && landscapeTerminalState.status.bottom <= landscapeTerminalState.shell.bottom && landscapeTerminalState.status.left >= landscapeTerminalState.shell.left && landscapeTerminalState.status.right <= landscapeTerminalState.shell.right, `landscape terminal message is clipped: ${JSON.stringify(landscapeTerminalState)}`);
  assert.ok(landscapeTerminalState.horizontalOverflow <= 1, `landscape terminal overflows horizontally: ${JSON.stringify(landscapeTerminalState)}`);
  assert.equal(landscapeTerminalState.activeId, "restart", `landscape terminal focus is not on Play again: ${JSON.stringify(landscapeTerminalState)}`);
  await landscapeTouch.close();

  const play = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await play.goto(baseUrl);
  await play.locator("#spec-file").setInputFiles({
    name: "inkling-game.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(gameSpec)),
  });
  await play.locator("canvas").waitFor();
  assert.equal(await play.locator("body.play-mode").count(), 1, "saved game did not enter play mode");
  const standardPhoneNewDrawing = await play.locator(".new-drawing-action").boundingBox();
  assert.ok(standardPhoneNewDrawing && standardPhoneNewDrawing.width >= 48 && standardPhoneNewDrawing.height >= 48, `standard-phone New drawing target is too small: ${JSON.stringify(standardPhoneNewDrawing)}`);
  const objective = await play.locator("#objective-detail").evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    whiteSpace: getComputedStyle(element).whiteSpace,
  }));
  assert.ok(objective.scrollWidth <= objective.clientWidth + 1 || objective.whiteSpace !== "nowrap", "objective is ellipsized");
  assert.equal(await play.locator("#accessible-controls").getAttribute("data-layout"), "side");
  await play.locator("#fullscreen-game").click();
  await play.waitForFunction(() => document.fullscreenElement?.id === "play-stage");
  await play.getByRole("button", { name: "Exit full screen" }).click();
  await play.waitForFunction(() => document.fullscreenElement === null);
  const rightControl = play.locator('[data-game-control="right"]');
  await rightControl.dispatchEvent("pointerdown", {
    pointerId: 1,
    pointerType: "touch",
  });
  await play.waitForTimeout(6_500);
  await rightControl.dispatchEvent("pointerup", {
    pointerId: 1,
    pointerType: "touch",
  });
  await play.locator("body.game-won").waitFor();
  assert.equal(await play.locator("#accessible-controls").isVisible(), false, "terminal state leaves movement controls visible");
  assert.equal(await play.locator("#game-status").isVisible(), true, "win celebration is hidden");
  assert.equal(await play.getByRole("button", { name: "Play again" }).isVisible(), true, "replay action is hidden after a win");
  await play.getByRole("button", { name: "Play again" }).click();
  await play.locator("body.playing").waitFor();
  await play.locator("#fullscreen-game").click();
  await play.waitForFunction(() => document.fullscreenElement?.id === "play-stage");
  await rightControl.dispatchEvent("pointerdown", { pointerId: 2, pointerType: "touch" });
  await play.waitForTimeout(6_500);
  await rightControl.dispatchEvent("pointerup", { pointerId: 2, pointerType: "touch" });
  await play.locator("body.game-won").waitFor();
  assert.equal(await play.locator("#accessible-controls").isVisible(), false, "fullscreen win leaves movement controls visible");
  assert.equal(await play.getByRole("button", { name: "Play again" }).isVisible(), true, "fullscreen win hides replay");
  assert.equal(await play.locator("#fullscreen-new-drawing").isVisible(), true, "fullscreen win has no new-drawing path");
  await play.locator("#fullscreen-new-drawing").click();
  await play.waitForFunction(() => document.fullscreenElement === null);
  assert.equal(await play.locator("body.play-mode").count(), 0, "new drawing did not leave the fullscreen game");
  await play.close();

  const failedPlayer = await browser.newPage({ viewport: { width: 390, height: 844 } });
  let blockedPlayerChunk = true;
  await failedPlayer.route("**/assets/platformer-*.js", async (route) => {
    if (blockedPlayerChunk) {
      blockedPlayerChunk = false;
      await route.abort("connectionfailed");
      return;
    }
    await route.continue();
  });
  await failedPlayer.goto(baseUrl);
  await failedPlayer.locator("#spec-file").setInputFiles({
    name: "recoverable-game.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(gameSpec)),
  });
  await failedPlayer.locator("body.player-error").waitFor();
  assert.equal(await failedPlayer.locator("#accessible-controls").isVisible(), false, "failed player leaves movement controls visible");
  assert.equal(await failedPlayer.getByRole("button", { name: "Play again" }).isVisible(), true, "failed player has no retry");
  await failedPlayer.getByRole("button", { name: "Play again" }).click();
  await failedPlayer.locator("canvas").waitFor();
  await failedPlayer.locator("body.playing").waitFor();
  await failedPlayer.close();

  const smallFullscreen = await browser.newPage({ viewport: { width: 320, height: 568 } });
  await smallFullscreen.goto(baseUrl);
  await smallFullscreen.locator("#spec-file").setInputFiles({
    name: "small-fullscreen-game.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(gameSpec)),
  });
  await smallFullscreen.locator("canvas").waitFor();
  await smallFullscreen.locator("#fullscreen-game").click();
  await smallFullscreen.waitForFunction(() => document.fullscreenElement?.id === "play-stage");
  const smallRight = smallFullscreen.locator('[data-game-control="right"]');
  await smallRight.dispatchEvent("pointerdown", { pointerId: 3, pointerType: "touch" });
  await smallFullscreen.waitForTimeout(6_500);
  await smallRight.dispatchEvent("pointerup", { pointerId: 3, pointerType: "touch" });
  await smallFullscreen.locator("body.game-won").waitFor();
  const terminalRects = await smallFullscreen.evaluate(() => {
    const statusRect = document.querySelector("#game-status")!.getBoundingClientRect();
    const actionsRect = document.querySelector("#post-play-actions")!.getBoundingClientRect();
    return {
      statusBottom: statusRect.bottom,
      actionsTop: actionsRect.top,
      statusColor: getComputedStyle(document.querySelector("#game-status")!).color,
    };
  });
  assert.ok(terminalRects.actionsTop >= terminalRects.statusBottom, `fullscreen terminal actions cover the result: ${JSON.stringify(terminalRects)}`);
  assert.equal(terminalRects.statusColor, "rgb(23, 79, 60)", "fullscreen win copy loses its readable foreground");
  await smallFullscreen.close();

  const lossSpec = structuredClone(gameSpec);
  lossSpec.rules = { ...(lossSpec.rules as Record<string, unknown>), lives: 1 };
  const loss = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await loss.goto(baseUrl);
  await loss.locator("#spec-file").setInputFiles({
    name: "one-life-game.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(lossSpec)),
  });
  await loss.locator("canvas").waitFor();
  const lossRight = loss.locator('[data-game-control="right"]');
  await lossRight.dispatchEvent("pointerdown", { pointerId: 4, pointerType: "touch" });
  await loss.locator("body.game-lost").waitFor({ timeout: 8_000 });
  await lossRight.dispatchEvent("pointerup", { pointerId: 4, pointerType: "touch" });
  assert.equal(await loss.locator("#game-status").textContent(), "No lives left. Tap Play again to try again.");
  assert.equal(await loss.locator("#accessible-controls").isVisible(), false, "loss leaves movement controls visible");
  assert.equal(await loss.evaluate(() => (document.activeElement as HTMLElement | null)?.id), "restart", "loss does not move focus to Play again");
  await loss.getByRole("button", { name: "Play again" }).click();
  await loss.locator("body.playing").waitFor();
  assert.match(await loss.locator("#game-status").textContent() ?? "", /Lives 1/);
  await loss.close();

  const maze = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await maze.goto(baseUrl);
  await maze.locator("#spec-file").setInputFiles({
    name: "maze-game.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ ...gameSpec, primary_genre: "maze" })),
  });
  await maze.locator("canvas").waitFor();
  const positions = await maze.locator("#accessible-controls").evaluate((controls) => {
    const box = (name: string): DOMRect => controls.querySelector<HTMLElement>(`[data-game-control="${name}"]`)!.getBoundingClientRect();
    const up = box("jump");
    const left = box("left");
    const down = box("down");
    const right = box("right");
    return { up: { x: up.x, y: up.y }, left: { x: left.x, y: left.y }, down: { x: down.x, y: down.y }, right: { x: right.x, y: right.y } };
  });
  assert.ok(positions.up.y < positions.left.y, "four-way Up is not above the directional row");
  assert.ok(positions.left.x < positions.down.x && positions.down.x < positions.right.x, "four-way controls are not a spatial D-pad");
  await maze.close();

  console.log("Client UI browser contract passed: phone/desktop/tablet/landscape-touch viewports, review/progress/recovery, play/fullscreen/win/replay, and spatial controls.");
} finally {
  await browser.close();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}
