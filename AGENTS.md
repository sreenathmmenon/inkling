# AGENTS.md

Guidance for AI coding agents (Codex / GPT-5.6) working in this repo.
Read this fully before writing or changing code. The rules in
**Non-Negotiables** are demo-critical: breaking them silently breaks the
product. When a request conflicts with this file, follow this file and say so.

---

## 1. What this project is

**Inkling** turns a photo of any hand drawing into a real, playable game in
seconds. A child draws on paper, points a phone at it, and plays — their
drawn character alive in their own crayon style.

The magic is a live trick on unpredictable input, so **reliability is the
product, not a quality bar**. Most rules below exist to protect that.

Two kinds of "agent" live in this codebase — keep them separate:
- **You** (the build-time coding agent) building the app.
- **Runtime model prompts** (GameSpec extraction, behavior codegen, etc.)
  that run inside the product. These are specified in
  `/docs/prompt-and-model-spec` — do not inline, duplicate, or "improve"
  those prompts from code. Treat them as a fixed contract.

---

## 2. Non-Negotiables (never violate)

1. **Lane A must always produce a playable game.** The deterministic lane
   (a prebuilt genre template filled with GameSpec data) is the floor.
   Never make Lane A depend on model-written code, network success, or
   Lane B. If everything else fails, Lane A still plays. Do not "simplify"
   by merging the lanes.

2. **Generated / model-written code never runs outside the sandbox.**
   Bespoke behavior modules (Lane B) execute only inside the sandboxed
   worker/iframe with **no network, no storage, no DOM, no globals, no
   imports outside the Behavior SDK**. Never widen this surface. Never
   `eval` model output on the main thread.

3. **A failed Lane B module must fail closed, never throw.** If a behavior
   module fails validation or errors at runtime, the entity falls back to
   `static`. The player must never see a crash. No uncaught errors escape
   the sandbox.

4. **Never restyle or "clean up" the child's art.** The wobble is the soul.
   Preserve original strokes; do not replace a drawn hero with a stock
   sprite or run generated art through a "beautify" pass. Style
   preservation is a product invariant.

5. **Safety gates are mandatory and ordered.** The pre-check runs before any
   generation; share-moderation runs before anything becomes public. Never
   bypass, reorder, or make them "optional for now." No camera frame with a
   real face or readable personal data proceeds. This is a kids' product.

6. **Every game must be finishable.** Nothing is marked ready (and nothing
   is shared) until the solvability check passes. Don't skip it to save time.

7. **Don't touch the model/effort routing without reason.** Model tier and
   `reasoning.effort` per call are chosen deliberately (see the prompt spec).
   Don't globally bump effort to "improve quality" or swap Sol→Luna to save
   cost without an eval. Ask / flag instead.

If you think a Non-Negotiable is wrong, stop and surface it — do not route
around it.

---

## 3. Stack (and why — don't second-guess these)

- **Game engine: Phaser 4.** Chosen deliberately: best stability/perf of the
  2D web engines, best iOS/WebKit behavior (every iOS browser is WebKit; we
  are camera-first mobile), headless mode for the solvability harness, and
  the **lowest model-hallucination rate** because of documentation mass.
  Do not migrate to another engine or hand-roll one.
- **Client:** mobile web + app shell; web player must open with **no install**
  (shared links open in a plain browser).
- **Capture pipeline:** on-device crop / de-skew / lighting correction. Frames
  are cropped to the drawing **before** anything leaves the device.
- **Backend:** stateless generation service (spec / code / assets),
  asset store, share/link service, moderation service, headless-Phaser
  solvability fleet.
- **Models:** OpenAI **Responses API**. GameSpec on GPT-5.6 Sol; cheap gates
  on Luna; mid work on Terra; behavior code on `gpt-5.2-codex` via the native
  `apply_patch` tool. Use structured outputs (`strict: true`) for all
  data-returning calls.

Language/runtime and framework specifics live in `/README.md`; this file
governs behavior and invariants, not setup.

---

## 4. Architecture map (where things go)

```
/apps/client        # capture UI, materialize animation, player shell
/packages/runtime   # Phaser genre templates (Lane A) — the deterministic floor
/packages/sdk       # Behavior SDK + headless validator (Lane B target/contract)
/services/gen       # generation orchestration (calls the runtime prompts)
/services/safety    # pre-check + share moderation
/services/solve     # headless solvability + repair harness
/docs               # prompt & model spec, product plan — source of truth
```

- **Genre templates** are complete, battle-tested games parameterized by a
  GameSpec. Adding a genre = adding a template here, fully self-contained.
- **Behavior modules** target the SDK contract only. If you change the SDK,
  update the validator in the same change.

---

## 5. Working conventions

- **Small, single-purpose changes.** One behavior/module/template per file.
- **Deterministic given a seed.** No wall-clock, no unseeded randomness in
  gameplay code (use `ctx.rng`, `ctx.time`).
- **Prefer editing existing templates/SDK over inventing new abstractions.**
- **Match existing style**; don't reformat untouched files.
- **No new dependencies** without flagging why — especially anything that
  runs in the sandbox or bloats the mobile bundle.
- **Never commit secrets / API keys.** The `safety_identifier` is a
  privacy-preserving per-user hash, not PII.

### Commands
> Fill these in as the repo lands; keep this list current so agents can
> self-verify instead of guessing.
```
Install:   npm install
Dev:       npm run dev
Test:      npm test          # run before finishing any change
Lint/type: npm run typecheck
Headless solvability: npm run solvability
```

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

---

## 6. Definition of done (self-check before you finish)

- [ ] Lane A still boots and plays with **no** model/network dependency.
- [ ] Any generated/bespoke code stays inside the sandbox; failure falls
      back to `static`, no throw.
- [ ] Child art is preserved, not restyled.
- [ ] Safety gates unbypassed; solvability passes.
- [ ] Model tier + effort unchanged (or the change is flagged with a reason).
- [ ] Tests + lint/type pass. Deterministic given a seed.
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
sandbox boundary, the two-lane split, the safety gates, or the child-art
invariant. A correct "I stopped because this conflicts with AGENTS.md" is
better than a silent workaround that breaks the demo.
