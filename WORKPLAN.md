# Inkling — Work Plan

Sequenced improvement work. Read `AGENTS.md` first; its Non-Negotiables are absolute
and outrank anything written here.

**How to run this:** work one group at a time (see "Running a group" at the
bottom). Do not run the full verify chain after every task — use the fast check per task and
the group checkpoint at each group boundary.

**Sequence matters.** A establishes truth. B protects the core promise. C makes games
alive. D closes the vocabulary gap. E builds the experience layer. F hardens.
Running C before B ships behaviors that a recast erases.

---

## GROUP A — Make the foundations true

### A1 · Make `spec/pipeline.json` genuinely authoritative

The project's stated architecture is "the spec is authoritative — change the spec, not the
runner." That is currently only half true. Model, effort, prompt path, and schema are
enforced per request, but these declared fields are never read: `loop_until`,
`blocks_pipeline_on`, `hard_requires`, `fan_out_over`, `validator`, `cache_stable_prefixes`,
`optional`, and the entire `execution_graph`. Ordering, blocking, looping, and fan-out are
reimplemented imperatively inside `scan()`. Real drift already exists: P1 blocks on an
unresolved `uncertain` verdict while the spec declares blocking only on `block`.

Make the declared control-flow semantics actually drive execution.

- Implement a spec-driven executor that reads and honors every field above. Ordering,
  gating, looping, conditional execution, and fan-out must derive from the spec.
- Where current behavior is *more correct* than the declaration (P1 blocking on unresolved
  uncertain is more correct), fix the DECLARATION to match the safer behavior. Never loosen
  a gate to satisfy a spec line.
- Any field genuinely not needed is removed from the spec entirely. No field may exist unread.
- Add a test that fails if a field is present in `pipeline.json` but never consumed.
- Wire P7's declared `escalate_to`, or remove the declaration.

**Done:** every field consumed, drift test passes, gates unchanged or stricter.

### A2 · Fix the few-shot examples so they satisfy the contract they teach

The few-shot examples violate the strict schema they teach. Every entity omits the required
(nullable) `linked_to`, and at least one example's `reach_goal` targets an entity whose role
is `platform`. They are injected as raw message history so nothing fails at runtime — the
model is simply shown output its own contract would reject. This degrades P2, the most
important call in the product.

- Every example must validate against the strict schema exactly as the model must produce it.
- Fix any example whose goal target, role assignment, or geometry is semantically wrong.
- Each example should teach a distinct lesson clearly: classic first scan, maze, semantic
  physics with no color legend, handwriting-as-rules, deliberately absurd input. Improve or
  replace any that teach weakly.
- Add a test validating every example against the live schema.

**Done:** all examples validate, new test passes, each teaches a distinct capability.

### A3 · Instrument so quality decisions are evidence-based

Nobody knows how often the P8 recast fires, how often PlayContract returns
`related_fallback` or `needs_recast`, how often certification fails, or the real
time-to-first-playable. Decisions are being made without measurement.

- Record per generation: time to playable, per-call latency and model/effort, P8 iteration
  count, whether a recast fired and at which rung, PlayContract outcome, certification
  result, final genre.
- No image data, no drawing content, no personal data, no raw model output. Aggregate
  anonymous counters only, consistent with the no-retention posture.
- Operator-only exposure — never to the client.
- A local report command summarizing a `validate:drawing-set` run across these dimensions.

Also make the batch evaluator practical to run repeatedly. Today it scans sequentially, does
not recurse into subdirectories, and re-runs everything from scratch — so a full corpus pass
is slow enough that it gets skipped, which defeats the purpose of having evidence.

- Recurse into subdirectories so a corpus organized into rounds or batches works directly.
  The current "No supported images found" error must also say when images exist deeper.
- Add `--concurrency N` for parallel scans (default a safe small number). Each generation is
  already request-isolated; the aggregation must stay correct regardless of concurrency.
- Add `--sample N` for a deterministic seeded subset, so a fast smoke pass is one flag rather
  than a separately maintained folder.
- Skip images already recorded as passing for the current revision, so a re-run after a small
  fix is incremental rather than a full repeat.
- De-duplicate by content hash so repeated copies of the same drawing are not counted twice.

**Done:** a drawing-set run produces a quality report with recast rate, contract outcome
distribution, certification failure rate, and latency percentiles — and the run is fast
enough to actually be repeated, with recursion, concurrency, sampling, and resume working.

---

## GROUP B — Protect the core promise

### B1 · Redesign the P8 recast so the child's drawing stays the game

When bounded repair fails, the safety recast forces genre to platformer, injects synthetic
ground and finish, and demotes the child's drawn entities to **non-colliding decorations**.
Synthetic entities are refused art, so they render as generic silhouettes. The result is a
generic platformer with the child's drawing as wallpaper — "your drawing becomes the game"
silently degrades to "your drawing decorates a game." The recast is also reserved for the
last two of four iterations, so only two genuine repair attempts ever happen, and it wipes
all P7 behavior patches.

- Redesign recast as a **graded ladder**, not one destructive step. Earlier rungs keep drawn
  entities collidable and keep their roles, simplifying only what blocks finishability
  (widen a gap, soften a hazard, lower a required interaction, add minimal reachable support).
- Only the final rung may introduce synthetic geometry — and even then drawn entities stay
  part of the playable world wherever they can be made safe.
- Rebalance the iteration budget so genuine repair gets meaningfully more attempts before any
  rung alters the child's world. Justify the numbers with A3 data, not guesswork.
- Preserve every safety property: every rung certified by the deterministic playtester, model
  verdict never overrides the simulator, persistent failure still fails closed.
- Do not wipe behavior patches for entities that survive a rung intact.

**Done:** ladder implemented and tested per rung, drawn entities stay playable wherever safe,
existing solvability tests pass, new tests cover art-and-role preservation.

### B2 · End silent degradation — make the honesty visible to the child

The product is rigorously honest with itself and silent with the child. A recast changes the
world with no explanation; a failed certification means the child plays an uncertified,
share-blocked game with no signal. The best thing in this codebase never reaches the person
using it.

- When the world was simplified, tell the child in their language, positively framed
  ("I made this one a little simpler so you can finish it!"). Never expose internal terms.
- When certification fails, do not let the game silently appear normal. Either withhold
  readiness with a friendly retry, or clearly mark it unverified with reduced affordances.
- Distinguish the two things currently both called "recast" (PlayContract `needs_recast`
  panel vs the P8 safety recast) in code naming and copy.
- Add assumption chips: show what the model inferred ("I made the red blob an enemy") so a
  child can correct a wrong reading. Corrections re-derive through the same gates.
- All copy through the existing allowlist, announced to assistive tech, reduced motion honored.

**Done:** no degradation path is silent, chips let a child correct an interpretation, tests
cover each message path and its accessibility announcement.

---

## GROUP C — Make the games feel alive

### C1 · Execute validated P7 behaviors in the runtime

**Requires B1 complete.** The P7 call generates per-entity behavior modules, they are statically
validated and simulated in a locked-down child-process VM — and the browser never executes
them. A child who draws a patrolling monster gets a correct interpretation and plays a game
where the monster stands perfectly still. `patrol`, `chase`, `spinner`, `shooter`, `faller`,
`rise` are all inert. This is the largest gap between what the product understands and what
the child experiences.

- Behaviors run only inside the existing sandbox boundary. No widening of the validator's
  allowances to make something work.
- Lane A remains the floor: fully playable before any behavior applies; behaviors hot-swap in
  only after validation; any failure falls back to `static`, silently to the player, never
  throwing into gameplay.
- Deterministic given a seed so the analytic playtester and browser replay stay in agreement.
  A level with a patrolling hazard must still be provably finishable.
- Update PlayContract so `dynamic_entity_behavior` becomes genuinely supported — once it is.
- If the playtester cannot reason about a behavior, that behavior does not ship as faithful.
  Extend the playtester rather than lowering the honesty bar.

**Done:** a drawn patrolling enemy patrols, solvability and replay still certify, sandbox
tests unchanged or stricter, PlayContract truthfully reports the new capability.

### C2 · Consume the P4 background and P5 sound plans

P4 produces a parallax plan and P5 selects a sound pack. Both are generated, returned, and
discarded. Two model calls per scan produce nothing the child sees or hears.

- Consume the P4 layer plan for backdrop and parallax, using only colors and texture from the
  child's own page (isolation modifies alpha, never RGB). The backdrop must never compete with
  or obscure the child's playable art.
- Build the sound pack registry P5 selects from; play the selected pack's voices for existing
  semantic events. Keep: gesture-gated, short, quiet, mute persisted, never the sole carrier
  of state information.
- Both degrade cleanly — missing or invalid plan leaves current behavior, play unaffected.
- If either proves to add no perceptible value, say so and recommend removing the call rather
  than keeping a decorative dependency.

**Done:** the played game visibly uses the backdrop and audibly uses the pack; fallbacks tested.

---

## GROUP D — Close the vocabulary-versus-engine gap

### D1 · Faithful roller and slingshot templates

Seven genres are declared; only platformer, maze, and runner are faithful. Roller has no
rolling inertia. Slingshot's "launch" is aliased to free movement — no real aim-and-launch
trajectory. A child who draws a ball-and-slope world gets an honest fallback instead of the
game they drew.

- Roller: real rolling inertia, slope response, momentum conservation, tilt or drag control —
  deterministic, fixed-step, consistent with the existing physics contract.
- Slingshot: real aim-and-launch with drag-to-launch, deterministic flight, target interaction.
- Extend the analytic playtester to genuinely solve both, and the replay policies and trace
  validator to certify them. A genre is not faithful until the solver finishes it and a real
  replay produces a legal trace.
- Update capability profiles so `faithful_ready` is reported honestly.
- Preserve original-art rendering and every safety guarantee.

**Done:** both reach `faithful_ready` with solver routes and valid receipts; genre truth table
updated.

### D2 · Faithful shooter and tower_defense — or remove them

**Requires D1** so the extended solver and trace vocabulary exist. Shooter has auto-aimed
projectiles for boss goals but no combat loop. `tower_defense` declares a `defend` action that
does nothing — dead vocabulary.

- Shooter: a real combat loop appropriate for young players — waves derived from drawn
  entities, deterministic firing, damage, a win condition the solver can reach. Keep auto-aim
  for young players unless testing shows otherwise.
- Tower defense: make `defend` real — placement or activation derived from the drawing,
  deterministic waves along the drawn path, a defensible win condition.
- Both must be solver-solvable and replay-certifiable before being reported faithful.
- **If either cannot be made genuinely good, recommend removing it from the schema vocabulary.**
  A smaller honest vocabulary beats a wider dishonest one.
- Remove the dead `mover` role and any other unreachable vocabulary, or implement it fully.

**Done:** all seven genres are either faithful-capable or deliberately removed; no declarable
role, behavior, or action is dead.

---

## GROUP E — Build the experience layer

### E1 · The materialize moment and a zero-empty-state first run

The moment a drawing becomes a game is currently a progress title, detail line, and timer.
The signature moment — ink lifting off the page, the world inflating — does not exist. First
run also starts empty, so a child with no drawing has nothing to do.

- Implement the materialize transition using the child's own scanned strokes, not generic
  particles. It should read as the drawing coming alive and cover the real generation wait
  honestly rather than faking a fixed duration.
- Fully honor reduced motion; never delay interactivity; never celebrate before an outcome is
  earned (simulation evidence must not trigger celebration).
- Pair it with sound designed as part of the same moment, within existing sound rules.
- First run offers something to scan immediately and a short draw prompt. No tutorial — the
  transformation teaches the product.
- Identical quality on phone, tablet, and large screen.

**Done:** the moment ships, reduced motion honored, no state is ever empty, UI verification
covers the new states.

### E2 · The physical loop — edit the paper, the world grows

P10 exists programmatically with no surface. Worse, **stitched output is never re-gated** — it
skips GameSpec shape validation and the entire P8 solvability gate. The tangible loop that
distinguishes this from every screen-only tool is unavailable to the child.

- **Close the gating hole first.** Stitched specs pass the same validation, safety, and
  solvability gates as any first scan. No path may produce a world that skipped a gate.
- Build the surface: after playing, add or change paper and rescan. The world updates rather
  than restarting, preserving progress where geometry allows.
- Support both adding a page and rescanning an edited page. An erased wall opens a gap; an
  added coin appears.
- The update feels continuous with the materialize moment, not a second loading screen.
- Art preservation, honesty, and accessibility unchanged.

**Done:** a child edits their drawing, rescans, and sees their world change; stitched worlds
pass every gate; tests cover gating and progress continuity.

### E3 · Voice as a design tool, and one-tap reinterpretation

Voice editing exists programmatically with no surface — a child who cannot spell "gravity"
cannot change their game. Separately, the extractor picks one genre reading and the child
cannot ask for another, though an alternate is already computed. Note: the voice path renames
`spec_diff_json` to `spec_diff` between schema and consumer — verify and fix that seam.

- Build the voice surface for young children: hold to speak, immediate visible result, no
  typing, no menus. Requests like making an enemy friendly or changing gravity apply as a
  minimal change to their existing world.
- Every voice edit re-derives through the same solvability and certification gates.
- One-tap reinterpretation using the already-computed alternate genre, same certification path.
- Speech respects the privacy posture: no retention, clear listening affordance, full function
  without it.
- Accessible equivalents for every voice action.

**Done:** a child can change their game by speaking and replay the same drawing as a different
kind of game — both gated, both accessible without voice.

---

## GROUP F — Harden and simplify

### F1 · Close remaining correctness and consistency gaps

Fix each, with a test where behavior is observable:

- **Dev server has no admission control** — rate limits, concurrency caps, and the generation
  deadline exist only in the production server. Development should exercise the same
  protections so production is never a surprise.
- **Two stacked size limits disagree** — the server accepts 12 MiB bodies while the drawing
  service rejects images over 8 MiB. Align so a rejected image is rejected once, at the right
  boundary, with the right message.
- **Dead code** — the unused non-stream JSON handler, the unused `isLatest` helper, and any
  other unreachable branch found in this pass.
- **Sandbox lexical checks false-positive on comments.** Make the static layer accurate so it
  does not reject valid modules; the VM permission model stays the real defense.
- **Fix the `spec_diff_json` / `spec_diff` naming seam** in the voice path.
- **Capture crop enables image smoothing**, mildly contradicting the never-resample promise.
  Make the code match the promise.
- **`package.json` still describes this repo as PDF pipeline automation.** Make the metadata
  describe the actual product.
- **A module is bundled twice.** The client build emits two chunks of byte-identical size
  (`platformer-*.js`, ~35 kB each), which indicates the same module entering the graph through
  two different import paths — likely related to the client importing from `services/solve/`
  and `runner/types` for in-browser certification. Find the duplicate path and remove it.
- **The heaviest chunk is attributed to one of the lightest modules.** Phaser lands inside a
  chunk named for `presentation-contract`, which is a small module. Fix the chunk boundary so
  the heavy dependency is split where it is actually used, making the >500 kB warning
  actionable rather than structural.

### F2 · Reduce brittleness so the product can keep improving

Several verification mechanisms are rigid in ways that now resist improvement: a hardcoded
SHA-256 fingerprint over all cross-module CSS overrides, exact color and pixel assertions in
the UI verifier, magic layout constants throughout the runtime tests, and a replay fixture
coupled to a specific frame index. Sensible review gates; now expensive friction.

- Replace exact-value assertions with assertions about the property that matters: contrast
  ratio not an exact color; relative position or invariant not a literal pixel; behavior at an
  event not a frame number.
- Keep a review gate for cross-module CSS overrides, but make it explain what changed rather
  than only failing on a hash mismatch.
- **Do not reduce coverage.** Every property currently protected stays protected, in a form
  that survives legitimate redesign.
- Add `typecheck` to the verify chain; make the bundle verifier build its own input rather
  than trusting stale output.
- Document in one place which tests are intentional review gates and what each protects.

---

## Running a group

Work one group at a time, in order. For the tasks that reshape core contracts — A1, B1,
C1, D1 — review the intended approach before any files change.

Use this instruction, substituting the group:

```
Work through GROUP A of WORKPLAN.md — tasks A1, A2, A3 — in order.

Read AGENTS.md first; its Non-Negotiables outrank anything in the work plan. If a task
conflicts with them, stop and tell me rather than routing around them.

For each task:
  1. Implement it fully, including its tests.
  2. Run the fast check from AGENTS.md §5 — typecheck plus only the tests affected.
     Fix anything that fails.
  3. Give me a two-line summary of what changed, then move to the next task.

Do NOT run the full verify chain between tasks.

After all tasks in the group are done, run the group checkpoint from AGENTS.md §5 and
report the results, including any regression versus the previous checkpoint and whether
the numbers change what to do next.

Stop and ask me if: a task conflicts with a Non-Negotiable, a task turns out to need a
decision I have not made, or the checkpoint fails in a way you cannot fix without
changing an invariant.
```

Start each group with a clean context.

## Check cadence

Defined in `AGENTS.md` §5. Summary:

| When | What | How often |
|---|---|---|
| After each task | fast check — typecheck + affected tests | 14x |
| After each group | group checkpoint — full verify + drawing corpus + quality report | 6x |
| Before a release claim | customer-grade gate — 10+ live browser journeys | rare |

### Which drawing corpus at which checkpoint

A full corpus pass is a live API run of many complete pipelines, so it is expensive. Only
run the full set where a change can actually alter *what game a child gets*. Everywhere else,
a small smoke set is enough to catch gross regressions.

Keep a **smoke set** of roughly six drawings covering the distinct paths: one platformer, one
maze, one runner, one water/semantic-physics, one colored or textured paper, one deliberately
messy. Once A3 lands, `--sample` produces this deterministically instead of a hand-maintained
folder.

| Group | What it changes | Corpus |
|---|---|---|
| A | routing, few-shot, instrumentation | smoke (run the full set once after A2, since it changes extraction) |
| **B** | **the recast ladder — directly changes the resulting world** | **full** |
| **C** | **behaviors execute — changes solvability of dynamic levels** | **full** |
| D | new genre templates | subset targeting the affected genres |
| E | experience and UI layer | smoke |
| F | hardening, no gameplay behavior change | smoke |

Compare like with like: smoke results only against a smoke baseline, full against full. A
corpus change read as a regression is worse than no measurement.
