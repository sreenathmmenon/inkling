import assert from "node:assert/strict";
import test from "node:test";

import {
  assessDrawingQuality,
  estimatePaperSkewDegrees,
} from "../apps/client/src/drawing-prep.js";

function pixels(width: number, height: number, value: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    data[offset] = value;
    data[offset + 1] = value;
    data[offset + 2] = value;
    data[offset + 3] = 255;
  }
  return data;
}

test("capture quality warns conservatively without rejecting unusual media", () => {
  const lowContrast = assessDrawingQuality(
    { width: 20, height: 20, data: pixels(20, 20, 220) },
    [0, 2, 18, 19],
    false,
  );
  assert.ok(lowContrast.warnings.includes("page_edge_uncertain"));
  assert.ok(lowContrast.warnings.includes("low_contrast"));
  assert.ok(lowContrast.warnings.includes("content_near_edge"));

  const highContrastData = pixels(20, 20, 255);
  for (let index = 0; index < 100; index += 1) {
    const offset = index * 4;
    highContrastData[offset] = 0;
    highContrastData[offset + 1] = 0;
    highContrastData[offset + 2] = 0;
  }
  const clear = assessDrawingQuality(
    { width: 20, height: 20, data: highContrastData },
    [3, 3, 17, 17],
    true,
  );
  assert.deepEqual(clear.warnings, []);
});

test("capture quality detects general page skew without reading drawing content", () => {
  const width = 120;
  const height = 100;
  const data = pixels(width, height, 35);
  for (let y = 8; y < 92; y += 1) {
    const pageLeft = Math.round(20 + y * 0.1);
    const pageRight = Math.round(94 + y * 0.1);
    for (let x = pageLeft; x < pageRight; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = 242;
      data[offset + 1] = 240;
      data[offset + 2] = 235;
    }
  }
  const angle = estimatePaperSkewDegrees({ width, height, data });
  assert.ok(angle > 4 && angle < 8, `expected about 5.7°, received ${angle}`);
  const quality = assessDrawingQuality({ width, height, data }, [30, 20, 80, 80], true);
  assert.ok(quality.warnings.includes("page_skewed"));
});

test("capture quality distinguishes an unfocused gradient from faint media", () => {
  const width = 80;
  const height = 80;
  const data = pixels(width, height, 255);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = Math.round(40 + (x / (width - 1)) * 190);
      const offset = (y * width + x) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
    }
  }
  const quality = assessDrawingQuality({ width, height, data }, [8, 8, 72, 72], false);
  assert.ok(quality.contrast > 0.16);
  assert.ok(quality.warnings.includes("blurry"));
});
