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

P7 patch operations are held in memory, validated statically, and simulated in
a Node permission sandbox with no network, project/data filesystem access,
filesystem writes, child processes, or inherited environment. Invalid modules return a `static`
fallback and are never installed. The deterministic playtest report is produced
before each P8 iteration; bounded repairs are applied and replayed until P8 is
ready or the configured iteration limit is exhausted.
