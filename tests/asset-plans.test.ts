import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_BACKDROP_ALPHA,
  parseBackdropPlan,
  planBackdropLayers,
} from "../packages/runtime/src/backdrop-contract.js";
import {
  resolveSfxPackId,
  SFX_PACK_IDS,
  soundVoicesFor,
} from "../apps/client/src/sound-feedback.js";
import {
  createPlayableGameDocument,
  resolvePlayableGame,
} from "../packages/runtime/src/artwork.js";
import type { RuntimeEventKind } from "../packages/runtime/src/runtime-events.js";
import type { GameSpec } from "../runner/types.js";

const SOUND_KINDS: RuntimeEventKind[] = [
  "pickup", "unlock", "assist_available", "assist_activated", "stuck_cue",
  "goal_blocked", "damage", "projectile", "win", "lose",
];

function spec(): GameSpec {
  return {
    primary_genre: "platformer", genre_confidence: 1, mood: "cheerful",
    hero: { id: "hero", name: "Hero", bbox: [0.1, 0.5, 0.2, 0.7], style_ref: "ink" },
    entities: [
      { id: "floor", role: "platform", bbox: [0, 0.72, 1, 0.8], behavior: "static", linked_to: null, style_ref: "ink" },
      { id: "finish", role: "goal", bbox: [0.8, 0.5, 0.9, 0.7], behavior: "static", linked_to: null, style_ref: "ink" },
    ],
    goal: { kind: "reach_goal", target_id: "finish" },
    rules: { lives: 3, difficulty_hint: "normal", modifiers: [] },
    palette: ["#3b6fb5", "#f5c518", "#e23b2e"], assumptions: [], flags: [],
  };
}

test("backdrop plans are bounded and degrade to nothing on any invalid input", () => {
  const plan = parseBackdropPlan({ layers: [{ source: "sky-wash", parallax: 0.3 }] });
  assert.ok(plan);
  assert.equal(plan.layers.length, 1);
  assert.equal(parseBackdropPlan(null), undefined);
  assert.equal(parseBackdropPlan({ layers: [] }), undefined);
  assert.equal(parseBackdropPlan({ layers: [{ source: "", parallax: 0.5 }] }), undefined);
  assert.equal(parseBackdropPlan({ layers: [{ source: "x", parallax: Number.NaN }] }), undefined);
  assert.equal(
    parseBackdropPlan({ layers: [{ source: "x".repeat(200), parallax: 0.5 }] }),
    undefined,
    "oversized source labels are refused",
  );
  const clamped = parseBackdropPlan({ layers: [{ source: "far", parallax: 9 }] });
  assert.equal(clamped?.layers[0]?.parallax, 1, "parallax clamps into [0,1]");
  const overfull = parseBackdropPlan({
    layers: Array.from({ length: 9 }, (_, index) => ({ source: `layer-${index}`, parallax: 0.5 })),
  });
  assert.equal(overfull?.layers.length, 3, "layer count is capped");
});

test("backdrop rendering uses only the child's palette and can never dominate the art", () => {
  const plan = parseBackdropPlan({
    layers: [
      { source: "far-hills", parallax: 0.2 },
      { source: "near-trees", parallax: 0.7 },
    ],
  });
  const layers = planBackdropLayers(plan, ["#3b6fb5", "#f5c518", "not-a-color"]);
  assert.equal(layers.length, 2);
  for (const layer of layers) {
    assert.ok(["#3b6fb5", "#f5c518"].includes(layer.color), "colors come from the page palette only");
    assert.ok(layer.alpha <= MAX_BACKDROP_ALPHA, "backdrop stays soft");
    assert.ok(layer.heightFraction <= 0.6 && layer.heightFraction >= 0.2);
    assert.ok(layer.scrollFactor >= 0 && layer.scrollFactor <= 1);
  }
  assert.deepEqual(planBackdropLayers(undefined, ["#3b6fb5"]), [], "no plan means no backdrop");
  assert.deepEqual(planBackdropLayers(plan, ["junk"]), [], "no usable palette means no backdrop");
  assert.deepEqual(
    planBackdropLayers(plan, ["#3b6fb5", "#f5c518"]),
    layers,
    "layer planning is deterministic",
  );
});

test("every SFX pack keeps every voice short, quiet, and semantically identical", () => {
  const base = new Map(SOUND_KINDS.map((kind) => [kind, soundVoicesFor(kind)]));
  for (const pack of SFX_PACK_IDS) {
    for (const kind of SOUND_KINDS) {
      const voices = soundVoicesFor(kind, pack);
      assert.equal(voices.length, base.get(kind)?.length, `${pack}/${kind} keeps the same cue shape`);
      for (const voice of voices) {
        assert.ok(voice.durationMs <= 330, `${pack}/${kind} stays short`);
        assert.ok(voice.gain < 0.05, `${pack}/${kind} stays quiet`);
        assert.ok(voice.frequency >= 80 && voice.frequency <= 1600, `${pack}/${kind} stays audible`);
      }
    }
  }
  assert.deepEqual(soundVoicesFor("input_accepted", "bright"), [], "packs never add cues to non-events");
});

test("unknown pack ids degrade to base", () => {
  assert.equal(resolveSfxPackId("bright"), "bright");
  assert.equal(resolveSfxPackId(" Bright "), "bright");
  assert.equal(resolveSfxPackId("jungle-drums-9000"), "base");
  assert.equal(resolveSfxPackId(42), "base");
  assert.equal(resolveSfxPackId(undefined), "base");
});

test("P4 and P5 results round-trip through the playable document and degrade cleanly", () => {
  const image = "data:image/png;base64,aGVsbG8=";
  const document = createPlayableGameDocument(spec(), image, undefined, undefined, undefined, {
    backdrop: { layers: [{ source: "sky", parallax: 0.4 }] },
    soundPack: { music_pack_id: "base", sfx_pack_id: "watery" },
  });
  assert.equal(document.backdrop?.layers[0]?.source, "sky");
  assert.equal(document.soundPack?.sfxPackId, "watery");
  const resolved = resolvePlayableGame(document);
  assert.equal(resolved.backdrop?.layers[0]?.parallax, 0.4);
  assert.equal(resolved.sfxPackId, "watery");

  const degraded = createPlayableGameDocument(spec(), image, undefined, undefined, undefined, {
    backdrop: { layers: "junk" },
    soundPack: { sfx_pack_id: 42 },
  });
  assert.equal(degraded.backdrop, null, "an invalid P4 plan is dropped, never guessed at");
  assert.equal(degraded.soundPack, null, "an invalid P5 pack is dropped, never guessed at");
  const resolvedDegraded = resolvePlayableGame(degraded);
  assert.equal(resolvedDegraded.backdrop, undefined);
  assert.equal(resolvedDegraded.sfxPackId, undefined);
});
