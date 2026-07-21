# Inkling — Spec-Driven Pipeline (automation)

Turns the **Prompt & Model Engineering Spec PDF** into something that runs
itself. No more copy-pasting each prompt into the right model by hand.

## The idea

```
   PDF  ──►  spec/pipeline.json  ──►  runner loops every call
 (human)      (machine truth)         with the right model+effort+prompt+schema
```

- **`spec/pipeline.json`** — every call from the PDF (P1–P11, P0, P2_photo) as
  a row: model, reasoning effort, prompt file, strict schema, dependencies,
  and whether it fans out / loops / is conditional. **This is the source of truth.**
- **`prompts/*.txt`, `spec/schemas/*.json`** — the actual prompt + schema text,
  extracted from the PDF (never hardcoded in code).
- **`runner/pipeline.ts`** — one loop. Resolves dependencies, runs
  `parallel_group`s concurrently (the fan-out), honors `loop_until`,
  `run_if`, `effort_router`, `escalate_to`, and passes each result into its
  dependents. Attaches strict Structured Outputs + few-shot + `safety_identifier`.
- **`.goal`** — the instruction you hand Codex to build & wire all of it.
- **`runner/extract_from_pdf.py`** — seeds the prompt/schema files from the PDF.

## Two ways to use it

### A. Let Codex build it (one shot)
```bash
codex --goal .goal --model gpt-5.2-codex --effort high
```
Codex reads `.goal`, loops over `pipeline.json` as its checklist, materializes
the prompt/schema files from the PDF, wires the runner, and runs the
self-verification test. This is the "/goal + loop" you asked for.

### B. Run the pipeline at runtime
```ts
import { runPipeline } from "./runner/pipeline";

// a child scanned a drawing:
const result = await runPipeline({ image }, { safetyId });
//  -> P1 gate -> P2 GameSpec (Sol/medium) -> assets fan-out (Terra/Luna)
//     -> P6 if uncertain (Sol/high) -> P7 behaviors (Codex, per-entity)
//     -> P8 solvability loop. Returns playable GameSpec + patches.

// photo mode:
await runPipeline({ photo, annotations }, { safetyId });
```

## Why it's safe (matches AGENTS.md)
- Model + effort come **only** from `pipeline.json` — change the spec, not code.
- Only `parallel_group` calls run concurrently; dependent chains stay ordered.
- Gates (P1/P8/P11) can't be skipped; `blocks_pipeline_on` halts the run.
- `strict:true` structured outputs everywhere a schema is declared.

## Bootstrap
```bash
python runner/extract_from_pdf.py \
  --pdf docs/Inkling-Spec.pdf \
  --spec spec/pipeline.json
npm install
npm run verify
```

`npm run verify` is self-contained from a fresh clone: the drawing corpus it
exercises is tracked at `fixtures/validation-drawings/round-1/` (generated
test drawings, not customer data). The multi-run corpus baseline uses the same
set via `npm run validate:drawing-set -- fixtures/validation-drawings/round-1
out.json --fresh`.

### Review-gate tests

`npm run verify` starts with `npm run typecheck`, so TypeScript errors fail the
chain before any test runs. Some files in the chain are **intentional review
gates**: they protect a product invariant, and a legitimate redesign changes
*how* the property is asserted, never *whether*. Each carries a header comment
naming what it protects:

| Gate | Protects |
|---|---|
| `scripts/verify-css-architecture.ts` | Ordered import-only CSS cascade; every cross-module override is reviewed. Diffs against `scripts/css-override-baseline.json` and explains selector/property-level changes; approve intentional changes by updating the baseline in the same commit. |
| `scripts/verify-client-bundle.ts` | Capture shell boots without Phaser; player stays a lazy chunk. Builds its own input. |
| `scripts/verify-client-ui.ts` | Real-browser accessibility, layout, contrast (ratio-based), and recovery contracts. |
| `scripts/verify-runtime-replay.ts` | Solver and production Phaser runtime agree; idle never wins; assist never tunnels. |
| `tests/solvability.test.ts` | Games are provably finishable; sandbox validation holds. |
| `tests/runtime-trace.test.ts` | Readiness is earned by a legal replay trace, never claimed. |
| `tests/replay-policies.test.ts` | Certification input policies stay deterministic and honest. |
| `tests/recast-ladder.test.ts` | Safety recast keeps the child's drawing playable; only the last rung adds synthetic geometry. |

`npm run audit:strict` separately checks the narrower JSON Schema subset
accepted by OpenAI Structured Outputs. This is stricter than parsing the files
as ordinary JSON Schema and intentionally exits non-zero when a source schema
would be rejected by the Responses API.

## Runtime entry points

`runPipeline({ image }, { safetyId })` and `runDrawingScan` run the drawing
workflow. `runPhotoScan` runs the mandatory P1 gate before `P2_photo`.
`runVoiceEdit`, `runMultipageStitch`, and `runShareModeration` cover their
conditional workflows; share moderation requires the passing P8 evidence from
the scan result.

The OpenAI client is created lazily and reads `OPENAI_API_KEY` from the process
environment. Every outbound request is checked against `pipeline.json` before
it is sent. Run `npm run dry-run` to print the call id, model, and effort without
making network requests.

## Play Lane A locally

The deterministic Phaser 4 platformer lives in `packages/runtime`. It maps the
GameSpec's normalized `0..1` boxes into a fixed 960×540 Arcade Physics world,
retains every `style_ref` as art metadata, and uses simple palette-colored
shapes when no extracted art asset is available. A safety floor and reachable
goal trigger keep the fallback lane finishable even when input geometry is
sparse. It never imports model-written behavior code and makes no API calls.

Play the successful live-scan fixture:

```bash
npm run play -- examples/live-scan-gamespec.json
```

Then open the local URL printed by Vite (normally `http://127.0.0.1:5173`).
You can also load another saved GameSpec using the browser's JSON file picker.

To close the complete drawing-to-game loop:

```bash
npm run scan -- /absolute/path/to/drawing.png --out examples/my-gamespec.json --playable-out examples/my-game.json
npm run play -- examples/my-game.json
```

`--out` remains a plain GameSpec for integrations. `--playable-out` writes a
local `inkling-playable-game-v1` document containing that GameSpec and an
inline copy of the original drawing. Lane A crops the original drawing by each
entity's normalized GameSpec bounds and renders those untouched crops over its
deterministic collision shapes. It accepts only inline image data for this
local document, never a remote artwork URL, so playback remains network-free.
The browser player can also save its currently loaded/generated game as JSON
and load that file later. A saved playable document keeps the GameSpec, source
artwork crop map, and optional P3 motion plan together.
Generated playable documents also carry the P8 playtest/solvability evidence
that produced them. Local evidence is useful for restoration and inspection;
public sharing still requires the server-owned P8/P11 gate evidence.

## Generation service boundary

`services/gen/src/drawing-service.ts` is the server-side entry point for a
cropped drawing. It accepts bounded inline image data only, runs the mandatory
P1 → generation → P8 sequence, and returns a `inkling-playable-game-v1`
document only after those gates pass. It requires a 64-character SHA-256
`safetyId`; production code must derive that identifier from its authenticated
or anonymous server session, never from browser JSON.

`services/gen/src/http.ts` exposes a framework-neutral `Request` → `Response`
adapter for `POST /api/games/drawing`. A deployment adapter must provide
`resolveSafetyId`, authentication/session handling, rate/request-size limits,
asset retention/deletion policy, and safe secret configuration. The browser
calls this same-origin endpoint and does not contain an OpenAI API key.

For the complete local browser loop (with a real API call only after the child
taps **Make my game**), run:

```bash
npm run dev
```

It creates an opaque, HttpOnly local session cookie and HMACs it server-side
into the required safety identifier. This development adapter is intentionally
local-only; a production host must replace its session, retention, rate-limit,
and secret-management mechanisms with its approved infrastructure.

The client capture screen validates supported image formats and size, detects
the drawing-content bounds, and creates a local PNG crop before a child taps
**Make my game**. Its crop operation does not apply art-restyling filters.

## Production web deployment

`npm run build:production` compiles the server and builds the Vite client into
`build/client`. `npm start` serves that immutable client bundle and the
same-origin generation API on `0.0.0.0:$PORT`. The production server requires
`OPENAI_API_KEY` and a stable, random `INKLING_SESSION_SECRET` of at least 32
characters. Both belong in the host's encrypted secret store and must never be
written to `.env` in a deployment image, client code, logs, or Git.

The committed `railway.json` uses Railpack, runs the production build and
start commands, checks `/healthz` before routing traffic, and applies bounded
restart/drain behavior. The production HTTP boundary uses secure anonymous
session cookies, HTTPS-aware same-origin checks, strict security headers,
bounded uploads, and per-session generation/concurrency limits. It does not
persist drawings or generated games server-side.

## Kid-first, no-account web flow

The primary player is deliberately usable without an account: a child can take
or choose a drawing, generate a private playable game, play it, and save the
result to their device. The web client sends only the prepared inline image;
it does not send a name, email, age, or arbitrary browser metadata. A visible
**Forget drawing** action clears the prepared image from the page before it is
ever sent or after a successful generation. The local development adapter uses
an opaque, session-only, `HttpOnly; SameSite=Strict` cookie solely to derive a
server-side safety identifier; it contains no child profile and is not a
durable account.

Generation responses and the local development player use `no-store`,
same-origin upload checks, a restrictive Content Security Policy, no-referrer,
and unused-device-permission denial headers. The development server remains a
local test tool, not production hosting. Production must additionally provide
HTTPS (`Secure` cookies), rate limits, abuse monitoring, deletion jobs,
approved asset storage, incident response, and a reviewed regional privacy
program.

Saving in a parent cloud library and every sharing feature are intentionally
out of the anonymous path. A future parent-controlled flow may offer those
features only after its applicable consent and age/privacy review. Public
profiles, comments, chat, advertising, and searchable galleries are not part
of this product boundary.

### Mobile web now; native app later

The no-account capture/player path is responsive, uses the device camera
chooser when available, keeps touch targets at least 44 CSS pixels, respects
safe-area insets, and has in-game touch controls. It is the first production
surface because a shared link can play in a browser with no install.

A future mobile app should keep this contract: on-device crop before upload,
the same server-side anonymous session/safety boundary, the same pipeline,
and the same deterministic `packages/runtime` Lane A player. Native capture,
local encrypted drafts, parent library, notifications, and platform sharing
adapters belong in an app shell around those shared packages—not inside
Phaser, model prompts, or model routing.

## Sharing gate

`services/share/src/share-service.ts` is deliberately moderation-only. It
requires both P8's ready verdict and replay evidence showing the goal was
reached, then calls P11. It does not create a public link or store assets.
Publishing infrastructure must call this gate first and retain immutable
P8/P11 evidence with the saved game it publishes.

P7 patch operations are held in memory, validated statically, and simulated in
a Node permission sandbox with no network, project/data filesystem access,
filesystem writes, child processes, or inherited environment. Invalid modules return a `static`
fallback and are never installed. The deterministic playtest report is produced
before each P8 iteration by a fixed-step Lane A simulation that shares the
platformer's world dimensions, gravity, jump, collision plan, hazards, lives,
collectibles, goal trigger, and survival timer. Bounded repairs are applied and
replayed until P8 is ready or the configured iteration limit is exhausted.
