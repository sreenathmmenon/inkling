import assert from "node:assert/strict";
import test from "node:test";

import { assessDrawingQuality } from "../apps/client/src/drawing-prep.js";

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
