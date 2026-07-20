# AGENTS.md

Guidance for AI coding agents working in this repo. Read this fully before writing or
changing code. The rules in **Non-Negotiables** are product-critical: breaking them
silently breaks the product. When a request conflicts with this file, follow this file
and say so.

---

## 1. What this project is

**Inkling** turns a photo of any hand drawing into a real, playable game. A child
draws on paper, points a phone at it, and plays — their drawn character alive in
their own crayon style, with their actual strokes rendered as the game's objects.

The magic is a live trick on unpredictable input, so **reliability is the
product, not a quality bar**. Most rules below exist to protect that.

Two kinds of "agent" live in this codebase — keep them separate:
- **You** — the build-time coding agent working on the app.
- **Runtime model prompts** (GameSpec extraction, behavior codegen, etc.) that run
  inside the product. These live as data in `prompts/*.txt`, with strict schemas in
  `spec/schemas/*.json` and routing in `spec/pipeline.json`. Do not inline, duplicate,
  or "improve" those prompts from code. To change model behavior, change the file.

---

## 2. Non-Negotiables (never violate)

1. **Lane A must always produce a playable game.** The deterministic lane
   (a prebuilt genre template filled with GameSpec data) is the floor.
   Never make Lane A depend on model-written code, network success, or
   Lane B. If everything else fails, Lane A still plays. Do not "simplify"
   by merging the lanes.

2. **Generated / model-written code never runs outside the sandbox.**
   Bespoke behavior modules (Lane B) execute only inside the sandboxed
   child-process VM with **no network, no storage, no DOM, no globals, no
   wall-clock time, no unseeded randomness, and no imports outside the Behavior
   SDK**. Never widen this surface to make something work. Never `eval` model
   output on the main thread.

3. **A failed Lane B module must fail closed, never throw.** If a behavior
   module fails validation or errors at runtime, the entity falls back to
   `static`. The player must never see a crash. No uncaught errors escape
   the sandbox.

4. **Never restyle or "clean up" the child's art.** The wobble is the soul.
   Artwork isolation modifies **alpha only, never RGB**. Do not replace a drawn
   hero with a stock sprite or run generated art through a "beautify" pass.
   Style preservation is a product invariant.

5. **Safety gates are mandatory and ordered.** P1 runs before any generation;
   P8 solvability runs before a game is materialized as playable; P11
   share-moderation runs before anything could become public. Never bypass,
   reorder, or make them "optional for now." No camera frame with a real face
   or readable personal data proceeds. This is a kids' product.

6. **Every game must be finishable, and readiness is earned, not claimed.**
   Nothing is marked ready until the deterministic playtester reaches the goal,
   the PlayContract audit agrees the engine can faithfully do what the spec
   declares, and a real replay of the solver's frames produces a legal trace.
   **A model's "ready" verdict may never override the simulator.**

7. **Report honest capability.** If something isn't truly supported, emit
   `related_fallback` or `needs_recast` — never a false `faithful_ready`.
   Widening the vocabulary without widening the engine is a regression.

8. **Model and effort come only from `spec/pipeline.json`.** Don't globally bump
   effort to "improve quality" or swap models to save cost without an eval.
   Flag it instead.

9. **No secrets in source, config, or prompts.** Keys come from the environment
   only. The `safety_identifier` is a server-derived privacy-preserving hash,
   never client-supplied, never PII. Never log it or the environment.

If you think a Non-Negotiable is wrong, stop and surface it — do not route
around it.

---

## 3. Stack (and why — don't second-guess these)

- **Game engine: Phaser 4, Canvas renderer** (not WebGL — mobile WebKit context
  ceilings). Chosen deliberately: best stability/perf of the 2D web engines, best
  iOS/WebKit behavior (every iOS browser is WebKit; we are camera-first mobile),
  headless-capable for the replay harness, and the lowest model-hallucination
  rate because of documentation mass. Do not migrate to another engine or
  hand-roll one. Fixed-step 60 fps arcade physics, 960×540 world.
- **Client:** Vite + plain TypeScript, no framework. Single-page state machine
  over body classes. The player (Phaser) is a **lazy chunk** — the capture shell
  must boot without it. No install; a saved game opens in a plain browser.
- **Capture pipeline:** on-device decode, surface detection (never assume white
  paper), crop / straighten / trim, quality warnings, ≤1600px output. Nothing
  leaves the device until the child taps Make my game.
- **Backend:** stateless with respect to customer content. No database, no
  persistence, no accounts. Playable documents are self-contained and
  network-free at play time; remote artwork URLs are rejected everywhere.
- **Models:** OpenAI **Responses API**, `store: false`, strict Structured Outputs
  on every data-returning call, per-request assertion that the outbound model and
  effort match the spec row.

Setup specifics live in `README.md`; this file governs behavior and invariants.

---

## 4. Architecture map (where things go)

```
apps/client/        capture UI, state machine, SSE, player shell, sound, motion, CSS cascade
packages/runtime/   Lane A: Phaser scene, layout/physics/materials, contracts,
                    artwork isolation & rendering, browser replay, coaching, feedback
packages/sdk/       Lane B: behavior validator + child-process VM sandbox
runner/             spec-driven Responses API orchestrator (P0-P11), routing
                    assertions, schema validation, dry-run
prompts/            ALL runtime model prompt text — data, never in code
spec/               pipeline.json (routing), schemas/ (strict), fewshot/
services/gen/       generation boundary: drawing service, HTTP/SSE, admission,
                    job authority
services/solve/     deterministic analytic playtester, replay policies, trace validator
services/share/     P11 moderation gate (no publishing infrastructure exists)
scripts/            dev server, production server, scan/play CLIs, verifiers
tests/              automated product, runtime, pipeline, service, UI contracts
docs/               local reference only — gitignored, NOT readable as source of truth
```

- **The source of truth for model behavior is `spec/` + `prompts/`**, not `docs/`.
- **Genre templates** are complete games parameterized by a GameSpec. Adding a
  genre means adding a real template *and* teaching the analytic playtester to
  solve it *and* updating the capability profile — not just a movement alias.
- **Behavior modules** target the SDK contract only. If you change the SDK,
  update the validator in the same change.

---

## 5. Working conventions

- **Small, single-purpose changes.** One behavior/module/template per file.
- **Deterministic given a seed.** No wall-clock, no unseeded randomness in
  gameplay code. The analytic playtester and the browser replay must stay in
  exact agreement — if you change physics, change both.
- **Prefer editing existing templates/SDK over inventing new abstractions.**
- **Match existing style**; don't reformat untouched files.
- **No new dependencies** without flagging why — especially anything that
  runs in the sandbox or bloats the mobile bundle (the Phaser chunk is already
  the heaviest asset).
- **Never commit secrets / API keys.**

### Commands

```
Install:              npm install
Dev (needs API key):  npm run dev
Full verify chain:    npm run verify
Tests only:           npm test              # NOTE: launches real Chromium
Typecheck:            npm run typecheck     # NOTE: NOT part of verify — run explicitly
Strict schema audit:  npm run audit:strict
Routing, no network:  npm run dry-run
Live scan one image:  npm run scan -- /abs/path/drawing.png --out game.json
Play a saved game:    npm run play -- examples/live-scan-gamespec.json
Batch real drawings:  npm run validate:drawing-set -- /abs/path/drawings/
Headless solvability: npm run solvability
Production:           npm run build:production && npm start
```

`npm run dev`, `scan`, and drawing-set validation load `.env` and need
`OPENAI_API_KEY`. Production additionally requires `INKLING_SESSION_SECRET`
(at least 32 chars) and a build revision.

### Verification cadence — do not over-verify

Running the full chain after every small change wastes time. Use three levels:

**1. Fast check — after each task.**
`npm run typecheck`, plus only the test files covering what you changed. Add
`npm run dry-run` if you touched the pipeline, `npm run audit:strict` if you touched a
schema. Seconds. Never claim a change is complete on typecheck alone.

**2. Group checkpoint — after each coherent group of work.**
`npm run typecheck`, then the full `npm run verify` chain, then
`npm run validate:drawing-set` against the real drawing corpus, then the quality report
(recast rate and which rung fired, PlayContract outcome distribution, certification
failure rate, latency percentiles, genre distribution). Report any measurable regression
versus the previous checkpoint, and say plainly whether the numbers change what should be
tuned next rather than proceeding on assumption.

**3. Customer-grade gate — before any release claim.** See §6.

Do not run the full chain between individual tasks.

### Product ownership and real-customer validation

- **Think as the product owner and architect.** When one failure is found,
  identify the whole failure class, every runtime path it can affect, and the
  invariant that prevents it from recurring. Never ship a drawing-, filename-,
  character-, or object-specific patch.
- **Kids are the primary customer.** A child must not become stuck because of
  collision geometry, jump timing, control sizing, multi-touch behavior,
  unreachable objectives, unclear feedback, or any other implementation
  detail. P8 is the minimum proof; the interactive runtime must be at least as
  capable and forgiving as the solver.
- **Validate like a real customer.** Exercise the visible upload, progress,
  game, retry, save/load, keyboard, and touch flows at realistic desktop and
  mobile sizes. Test ordinary taps, holds, early/late inputs, repeated actions,
  mistakes, recovery, and replay—not only exact scripted success paths.
- **Separate evidence honestly.** Automated tests, headless solvability,
  browser automation, and real child usability sessions are different kinds
  of evidence. Never describe automation as a real-user test or claim a child
  study that did not happen.
- **Treat UX quality as a product invariant.** Controls, progress, feedback,
  layout, readability, motion, and recovery must feel intentional, welcoming,
  and polished on mobile and web. Merely functional or technically passing is
  not done.
- **Design recovery, not dead ends.** Use general, deterministic safeguards
  such as safe spawn, forgiving input windows, reachable collision geometry,
  and clear retry/assist paths. No generated game may leave a player trapped
  with restart as the only unexplained option.
- **No silent degradation.** If the child's world was simplified, or a game
  could not be certified, the child is told in their own language. Internal
  honesty that never reaches the player is not honesty.

---

## 6. Definition of done (self-check before you finish)

- [ ] Lane A still boots and plays with **no** model/network dependency.
- [ ] Any generated/bespoke code stays inside the sandbox; failure falls
      back to `static`, no throw.
- [ ] Child art is preserved, not restyled; isolation touched alpha only.
- [ ] Safety gates unbypassed; solvability passes; readiness is earned by an
      actual replay, not claimed.
- [ ] Capability reporting is honest — no false `faithful_ready`.
- [ ] Model tier + effort unchanged (or the change is flagged with a reason).
- [ ] `npm run verify` passes, and `npm run typecheck` passes separately.
- [ ] Deterministic given a seed; solver and runtime still agree.
- [ ] Change is small, single-purpose, and matches existing conventions.

### Customer-grade completeness gate

Do not call a customer-facing feature complete or production-grade from unit,
integration, schema, or headless tests alone. Before making that claim, validate
at least **10 materially different end-to-end journeys in a real browser** as a
child or first-time customer would use them. The set must cover mobile and
desktop, colored and uncolored drawing backgrounds, different media and visual
density, different supported game structures, failure/recovery, replay, and a
second drawing attempt.

For every journey, inspect the full experience rather than only whether the
game boots: capture and progress feedback, understandable child-facing copy,
visual hierarchy, color and contrast, typography, spacing, touch targets,
controls, artwork preservation, absence of crop/background artifacts,
mechanical finishability, recovery from mistakes, and whether the ending makes
another drawing feel inviting. Remove controls, labels, or menus that do not
earn their place in that journey.

Treat any hardcoded noun, filename, sample-specific branch, or one-picture fix
as a failed review. Implement product-wide rules from image properties,
GameSpec semantics, deterministic geometry, and explicit capability contracts.
Record the tested scenario matrix and evidence. If all required journeys have
not passed, report the work as incomplete and name the remaining failures.

The final customer-grade gate runs only against the deployed live URL. Local
browser checks are useful diagnostics, but they do not establish completion.
For a release claim: commit and push the exact candidate, wait for its live
deployment to succeed, verify that production serves that revision, and run all
10+ end-to-end browser journeys there. If any live journey fails, return to the
fix -> automated verification -> commit/push -> deploy -> live-browser loop and
repeat the full affected matrix. Do not ask the user to perform this validation
or call an un-deployed/local result complete.

---

## 7. When unsure

Ask or flag rather than guess — especially on anything touching the
sandbox boundary, the two-lane split, the safety gates, the child-art
invariant, or honest capability reporting. A correct "I stopped because this
conflicts with AGENTS.md" is better than a silent workaround that breaks the
product.
