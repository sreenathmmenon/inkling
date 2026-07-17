import { runPipeline } from "./pipeline.js";

const result = await runPipeline(
  {
    image: "data:image/png;base64,dry-run",
    context: { capture_surface: "paper", device: "mobile", child_mode: true },
  },
  { safetyId: "inkling-dry-run", dryRun: true },
);

for (const call of result.calls) {
  console.log(`${call.callId}\t${call.model}\t${call.effort}`);
}
