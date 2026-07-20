import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  summarizeDrawingSetResults,
  type DrawingSetReport,
} from "./drawing-set-lib.js";

const reportArgument = process.argv[2];
if (!reportArgument) {
  throw new Error("Usage: npm run report:drawing-set -- <validation-report.json>");
}

const reportPath = resolve(reportArgument);
const report = JSON.parse(await readFile(reportPath, "utf8")) as DrawingSetReport;
if (!Array.isArray(report.results)) {
  throw new Error(`${reportPath} is not a drawing-set validation report`);
}
const summary = summarizeDrawingSetResults(report.results);

const percent = (value: number): string => `${(value * 100).toFixed(0)}%`;
const millis = (value: number): string => `${Math.round(value)}ms`;
const distribution = (counts: Record<string, number>): string =>
  Object.entries(counts)
    .sort(([, left], [, right]) => right - left)
    .map(([key, count]) => `${key}=${count}`)
    .join("  ") || "(none)";

console.log(`Drawing-set quality report — ${reportPath}`);
console.log(`Generated: ${report.generatedAt}  revision: ${report.revision}`);
if (report.sampled !== undefined) console.log(`Sampled subset: ${report.sampled} (seed ${report.seed})`);
console.log("");
console.log(`Cases: ${summary.total}  ready: ${summary.playable}  failed: ${summary.failed}`);
console.log(`Failures by code: ${distribution(summary.failureCodes)}`);
console.log(`PlayContract outcomes: ${distribution(summary.playContractOutcomes)}`);
console.log(`Final genres: ${distribution(summary.finalGenres)}`);
console.log(`Certification: ${distribution(summary.certification)}`);
console.log(
  `Safety recast rate: ${percent(summary.safetyRecastRate)}  ` +
  `objective fallback rate: ${percent(summary.objectiveFallbackRate)}  ` +
  `mean P8 iterations: ${summary.p8IterationsMean.toFixed(2)}`,
);
console.log(
  `Time to playable: p50 ${millis(summary.latencyMs.p50)}  ` +
  `p90 ${millis(summary.latencyMs.p90)}  max ${millis(summary.latencyMs.max)}`,
);
const callRows = Object.entries(summary.callLatencyMs)
  .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }));
if (callRows.length > 0) {
  console.log("");
  console.log("Per-call latency (p50 / max):");
  for (const [callId, stats] of callRows) {
    console.log(`  ${callId.padEnd(14)} ${millis(stats.p50).padStart(9)} / ${millis(stats.max).padStart(9)}  (${stats.count} calls)`);
  }
}
