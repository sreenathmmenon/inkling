import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  collectDrawingFiles,
  contentHash,
  dedupeByContentHash,
  planRun,
  sampleDeterministic,
  summarizeDrawingSetResults,
  type DrawingCaseResult,
  type DrawingSetReport,
} from "../scripts/drawing-set-lib.js";
import { percentile } from "../services/gen/src/quality-metrics.js";

function drawingFile(path: string, content: string): { path: string; hash: string } {
  return { path, hash: contentHash(new TextEncoder().encode(content)) };
}

function readyCase(overrides: Partial<DrawingCaseResult> = {}): DrawingCaseResult {
  return {
    path: "a.png",
    hash: "hash-a",
    status: "ready",
    durationMs: 1000,
    genre: "platformer",
    playContractOutcome: "faithful_ready",
    p8Iterations: 1,
    safetyRecast: false,
    objectiveFallback: false,
    ...overrides,
  };
}

test("drawing collection recurses into subdirectories and sorts numerically", async () => {
  const root = await mkdtemp(join(tmpdir(), "inkling-drawings-"));
  await mkdir(join(root, "round-2", "batch-b"), { recursive: true });
  await writeFile(join(root, "10-late.png"), "late");
  await writeFile(join(root, "2-early.jpg"), "early");
  await writeFile(join(root, "notes.txt"), "not a drawing");
  await writeFile(join(root, "round-2", "batch-b", "1-nested.webp"), "nested");

  const files = await collectDrawingFiles(root);
  assert.deepEqual(files, [
    "2-early.jpg",
    "10-late.png",
    join("round-2", "batch-b", "1-nested.webp"),
  ]);
});

test("duplicate drawing content is counted once regardless of file name", () => {
  const original = drawingFile("round-1/dog.png", "same-drawing");
  const copy = drawingFile("round-2/dog-copy.png", "same-drawing");
  const distinct = drawingFile("round-2/cat.png", "different-drawing");

  const { unique, duplicates } = dedupeByContentHash([original, copy, distinct]);
  assert.deepEqual(unique.map((file) => file.path), ["round-1/dog.png", "round-2/cat.png"]);
  assert.deepEqual(duplicates, [
    { path: "round-2/dog-copy.png", duplicateOf: "round-1/dog.png" },
  ]);
});

test("sampling is deterministic for a seed and preserves corpus order", () => {
  const files = Array.from({ length: 12 }, (_, index) =>
    drawingFile(`drawing-${index + 1}.png`, `content-${index + 1}`),
  );
  const first = sampleDeterministic(files, 5, 42);
  const second = sampleDeterministic(files, 5, 42);
  assert.deepEqual(first, second, "the same seed must select the same subset");
  assert.equal(first.length, 5);
  const positions = first.map((file) => files.indexOf(file));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), "original order is preserved");
  const other = sampleDeterministic(files, 5, 7);
  assert.notDeepEqual(other, first, "a different seed selects a different subset");
  assert.deepEqual(sampleDeterministic(files, 20, 42), files, "oversized samples keep everything");
});

test("a repeat run reuses passing results only at the same revision", () => {
  const passing = drawingFile("a.png", "content-a");
  const failing = drawingFile("b.png", "content-b");
  const fresh = drawingFile("c.png", "content-c");
  const previous: DrawingSetReport = {
    generatedAt: "2026-07-20T00:00:00.000Z",
    revision: "rev-1",
    concurrency: 2,
    results: [
      readyCase({ path: "a.png", hash: passing.hash }),
      { path: "b.png", hash: failing.hash, status: "failed", durationMs: 500, error: "boom" },
    ],
    summary: summarizeDrawingSetResults([]),
  };

  const sameRevision = planRun([passing, failing, fresh], previous, "rev-1");
  assert.deepEqual(sameRevision.toRun.map((file) => file.path), ["b.png", "c.png"]);
  assert.equal(sameRevision.reused.length, 1);
  assert.equal(sameRevision.reused[0]?.reused, true);
  assert.equal(sameRevision.reused[0]?.path, "a.png");

  const newRevision = planRun([passing, failing, fresh], previous, "rev-2");
  assert.equal(newRevision.reused.length, 0, "a new revision re-runs everything");
  assert.equal(newRevision.toRun.length, 3);

  const noReport = planRun([passing], undefined, "rev-1");
  assert.deepEqual(noReport.toRun, [passing]);
});

test("the quality summary reports rates, distributions, and latency percentiles", () => {
  const results: DrawingCaseResult[] = [
    readyCase({ durationMs: 1000 }),
    readyCase({
      path: "b.png",
      hash: "hash-b",
      durationMs: 3000,
      genre: "maze",
      playContractOutcome: "related_fallback",
      safetyRecast: true,
      p8Iterations: 4,
    }),
    {
      path: "c.png",
      hash: "hash-c",
      status: "failed",
      durationMs: 2000,
      error: "P8 exhausted its repair loop before ready",
    },
  ];
  const summary = summarizeDrawingSetResults(results);
  assert.equal(summary.total, 3);
  assert.equal(summary.playable, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.safetyRecastRate, 0.5);
  assert.deepEqual(summary.playContractOutcomes, { faithful_ready: 1, related_fallback: 1 });
  assert.deepEqual(summary.finalGenres, { platformer: 1, maze: 1 });
  assert.equal(summary.certification["not_measured"], 3);
  assert.equal(summary.p8IterationsMean, 2.5);
  assert.equal(summary.latencyMs.p50, 2000);
  assert.equal(summary.latencyMs.max, 3000);
  assert.equal(Object.keys(summary.failureCodes).length, 1);
});

test("percentiles use nearest-rank semantics on unsorted samples", () => {
  assert.equal(percentile([], 0.5), 0);
  assert.equal(percentile([7], 0.9), 7);
  assert.equal(percentile([30, 10, 20, 40], 0.5), 20);
  assert.equal(percentile([30, 10, 20, 40], 0.9), 40);
});
