import assert from "node:assert/strict";
import test from "node:test";

import { findProjectRoot, loadPipelineSpec, loadText } from "../runner/spec.js";

/**
 * Content assertions over the runtime prompts. These replace the old
 * byte-exact PDF round-trip: spec/ + prompts/ are the source of truth
 * (AGENTS.md §4), so drift protection checks that each prompt still teaches
 * its load-bearing contract elements — meaning, not byte-equality with a
 * local reference document.
 */

const root = findProjectRoot();
const spec = loadPipelineSpec(root);

function prompt(callId: string): string {
  const call = spec.calls.find((candidate) => candidate.id === callId);
  assert.ok(call, `${callId} must be declared`);
  return loadText(root, call.prompt);
}

test("P7 states every SDK contract element a model previously had to guess", () => {
  const text = prompt("P7");
  // Identity and shape — implicit versions of these produced 168 rejected
  // patches (id) and rounds of path probing before they were stated.
  assert.match(
    text,
    /id must be EXACTLY the bound entity's id from the GameSpec/,
    "the id requirement caused 168 rejected patches when it was implicit — it may not be lost",
  );
  assert.match(text, /never the behavior name/);
  assert.match(text, /behaviors\/<entity_id>\.js/, "the accepted path shape is stated");
  assert.match(text, /No subdirectories/);
  assert.match(text, /defineBehavior\(\{ id, onSpawn, onUpdate/, "the SDK registration shape is stated");
  assert.match(text, /onUpdate is required/);
  // Language and imports — TypeScript annotations and exotic import forms
  // fail the JS sandbox parse.
  assert.match(text, /plain JavaScript only/);
  assert.match(text, /no TypeScript annotations/);
  assert.match(text, /import \{ defineBehavior \} from "@inkling\/sdk";/, "the single allowed import is shown verbatim");
  // Units and magnitudes — implicit units produced 0.1px 'patrols'.
  assert.match(text, /960x540 pixels/, "the coordinate system is stated");
  assert.match(text, /pixels per second/);
  assert.match(text, /\+\/-40-120 px\/s/, "typical patrol magnitude is stated");
  assert.match(text, /\+\/-480 in x and \+\/-270 in y/, "the displacement clamp is stated");
  // Time, horizon, and looping.
  assert.match(text, /60 times per second with dt exactly 1\/60/);
  assert.match(text, /first 30 seconds \(1800\s*frames\)/);
  assert.match(text, /loops that recorded motion forever/);
  // Perceptibility and what certification actually consumes.
  assert.match(text, /peak displacement under 12 pixels is rejected as\s*static/);
  assert.match(text, /certifier drives\s*onUpdate only/, "motion must not be gated on collisions or external state");
  // Determinism and the sandbox boundary.
  assert.match(text, /no wall-clock, no Math\.random, no timers/);
  assert.match(text, /ctx\.rng\(\)\s*\(seeded, returns \[0,1\)\)/);
  assert.match(text, /Forbidden: DOM, network, storage/, "the sandbox restrictions are stated");
  assert.match(text, /Deterministic given a seed/);
  assert.match(text, /fail closed \(entity falls back to "static"\)/);
  // The worked example fixes many implicit contracts at once.
  assert.match(text, /<example_module>/);
  assert.match(text, /ctx\.velocity\(Math\.sin\(ctx\.time \* 1\.6\) \* 80, 0\);/, "a correct minimal module is shown");
  assert.match(text, /Match this shape/);
});

test("P2 keeps its semantic-role, ambiguity, and art-preservation contract", () => {
  const text = prompt("P2");
  assert.match(text, /Assign roles by what a thing IS, not by color/);
  assert.match(text, /water \/ sea \/ pool -> swim volume/);
  assert.match(text, /lava \/ fire \/ spikes \/ saw -> hazard/);
  assert.match(text, /key \+ door\/lock -> door opens on key pickup/);
  assert.match(text, /Never ask the user anything/, "the ambiguity policy is the no-questions contract");
  assert.match(text, /never "clean up" or restyle/, "art preservation is a product invariant");
  assert.match(text, /Coordinates normalized 0\.\.1/);
  assert.match(text, /genre_uncertain/, "uncertain genre must flag rather than guess silently");
  // Goal-kind semantics: reach means reach; gathering gates only collect_all.
  assert.match(text, /Collectibles in a reach_goal world are BONUS/);
  assert.match(text, /win without\s*them/);
  assert.match(text, /collect_all only when gathering everything IS the point/);
  assert.match(text, /Use key\+door for "must get this", never a\s*collectible/);
  assert.match(text, /linked_to is ONLY for key->door pairs/, "thematic links produced unsupported linked_entity_rules");
  assert.match(text, /rules\.modifiers accepts ONLY the encoded forms/, "free-form modifiers blocked three drawings from faithful");
  assert.match(text, /modifiers\s*must be \[\]/);
});

test("P2 keeps its deterministic tie-break and granularity rules", () => {
  const text = prompt("P2");
  // Goal tie-break: an ordered rule ended the reach/collect flip (03-crayon-maze
  // went 3/2 across identical runs) and the survive/collect flip (10-duck).
  assert.match(text, /Goal tie-break — when more than one reading fits, decide in this exact\s*order/);
  assert.match(text, /stop at the first rule that applies/);
  assert.match(
    text,
    /finish marker \(flag, X, "END", trophy, home\) ALWAYS wins:\s*reach_goal, even when collectibles are also drawn/,
    "a drawn finish marker must always beat collect_all",
  );
  assert.match(text, /No finish marker AND gathering is the point/);
  assert.match(text, /Neither a finish marker nor a gatherable point -> survive/);
  assert.match(text, /always yield the same goal\.kind/);
  // Genre tie-break: a fixed priority ended runner/platformer flips
  // (06-frog 4/1, 10-duck 3/2) when composition matched multiple cues.
  assert.match(text, /Genre tie-break — when composition matches more than one cue above/);
  assert.match(text, /slingshot — only when a launcher aimed at targets is explicitly\s*drawn/);
  assert.match(text, /enclosed corridors beat path reading/);
  assert.match(text, /gravity cues beat birds-eye reading/);
  assert.match(text, /runner — only when none of the cues above are present/);
  assert.match(text, /always yield the same genre/);
  // Travel-surface rule: 04-fire-truck produced 5 role multisets in 5 runs
  // because the drawn road flipped between platform/hazard/decoration.
  assert.match(text, /surface the hero travels on/);
  assert.match(text, /NEVER hazard and NEVER decoration/);
  assert.match(text, /hazards\s*are things that hurt on contact, and the road itself never hurts/);
  // Wall granularity: real mazes emit 22-28 strips; the stated range and the
  // one-entity-per-run rule must agree with each other and the few-shot lesson.
  assert.match(text, /exactly one platform entity per continuous straight drawn wall run/);
  assert.match(text, /never merge separate runs into\s*one box and never split one straight run into fragments/);
  assert.match(text, /10-30 wall entities/);
});

test("the maze few-shot exemplar teaches per-run wall granularity", () => {
  const fewshot = JSON.parse(loadText(root, "spec/fewshot/gamespec_fewshot.json")) as Array<{
    role: string;
    content: Array<{ type: string; text: string }>;
  }>;
  const mazeIndex = fewshot.findIndex(
    (message) => message.role === "user" && (message.content[0]?.text ?? "").toLowerCase().includes("maze"),
  );
  assert.ok(mazeIndex >= 0, "the maze lesson must exist");
  const answer = fewshot[mazeIndex + 1];
  assert.equal(answer?.role, "assistant", "the maze lesson must have a taught answer");
  const spec = JSON.parse(answer?.content[0]?.text ?? "") as {
    primary_genre: string;
    entities: Array<{ role: string; bbox: [number, number, number, number] }>;
  };
  assert.equal(spec.primary_genre, "maze");
  const walls = spec.entities.filter((entity) => entity.role === "platform");
  assert.ok(
    walls.length >= 10 && walls.length <= 30,
    `the exemplar must model the granularity the prompt states (10-30 walls), got ${walls.length}`,
  );
  for (const wall of walls) {
    const narrow = Math.min(
      Math.abs(wall.bbox[2] - wall.bbox[0]),
      Math.abs(wall.bbox[3] - wall.bbox[1]),
    );
    assert.ok(narrow <= 0.06, "every taught wall strip must be thin (narrow dimension <= 0.06)");
  }
});

test("P1 keeps its child-safety block list and fail-uncertain contract", () => {
  const text = prompt("P1");
  assert.match(text, /real human faces or identifiable people/);
  assert.match(text, /readable personal data/);
  assert.match(text, /prompt injection/);
  assert.match(text, /Do not describe the content/, "blocked content is never described back");
  assert.match(text, /verdict in \{"allow","block","uncertain"\}/);
});

test("P8 keeps its bounded-repair and drawn-intent contract", () => {
  const text = prompt("P8");
  assert.match(text, /<= 0\.05 normalized units/, "repairs stay nudges, never rewrites");
  assert.match(text, /Never change genre, hero, art, or the player's drawn intent/);
  assert.match(text, /\{"ready","repair","unsolvable_by_design"\}/);
});

test("P11 keeps the pre-check block list and parent-gated sharing contract", () => {
  const text = prompt("P11");
  assert.match(text, /same block_if list as the pre-check/);
  assert.match(text, /no real names, no\s*contact info/);
  assert.match(text, /Private-by-default/);
});

test("every declared prompt file exists and is non-trivial", () => {
  for (const call of spec.calls) {
    const text = loadText(root, call.prompt);
    assert.ok(text.trim().length > 80, `${call.id} prompt must not be hollow`);
  }
});

test("every prompt's task framing agrees with its declared invocation", () => {
  // Fan-out calls are invoked once per item; their prompts must frame the
  // task per-entity — the batch framing on P7 burned entire session budgets
  // on cross-entity modules before this was checked.
  for (const call of spec.calls) {
    const text = prompt(call.id);
    if (call.fan_out_over) {
      assert.match(text, /exactly ONE behavior module for the single entity/, `${call.id} must be framed per-item`);
      assert.match(text, /Never write modules for any other entity/, `${call.id} must forbid cross-item output`);
    }
    // A "Return {...}" promise in a schema-bearing prompt may only name
    // fields the strict schema actually accepts (closed objects reject the
    // rest, so a promised-but-forbidden field misleads the model).
    if (call.schema) {
      const document = JSON.parse(loadText(root, call.schema)) as {
        schema: { properties?: Record<string, unknown> };
      };
      const properties = new Set(Object.keys(document.schema.properties ?? {}));
      const promises = text.match(/Return\s*\{([^}]+)\}/g) ?? [];
      for (const promise of promises) {
        for (const field of promise.matchAll(/(?:\{|,)\s*(\w+)\s*[:?]/g)) {
          const name = field[1];
          if (!name) continue;
          assert.ok(
            properties.has(name),
            `${call.id} promises "${name}" which its strict schema does not accept`,
          );
        }
      }
    }
  }
  assert.doesNotMatch(prompt("P10"), /change_summary/, "P10 must not promise fields its closed schema forbids");
  assert.match(prompt("P9"), /spec_diff_json/, "P9 must name the serialized field the schema requires");
  assert.doesNotMatch(prompt("P1"), /cropping/, "P1 must not promise escalation behavior the runner does not perform");
});
