import assert from "node:assert/strict";
import test from "node:test";

import {
  generationErrorMessage,
  visibleGenerationFailure,
} from "../apps/client/src/generation-copy.js";

test("generation failures expose recovery copy but never raw transport details", () => {
  const generic = generationErrorMessage();

  assert.equal(visibleGenerationFailure(new TypeError("network error")), generic);
  assert.equal(visibleGenerationFailure(new Error("ECONNRESET api.openai.com")), generic);
  assert.equal(visibleGenerationFailure(new Error(generic)), generic);
  assert.equal(
    visibleGenerationFailure(new Error(generationErrorMessage("generation_rate_limited"))),
    generationErrorMessage("generation_rate_limited"),
  );
  assert.match(generationErrorMessage("game_not_finishable"), /tap Make my game to try once more/);
});
