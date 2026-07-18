import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import type { RequestTrace } from "../runner/types.js";
import { generateDrawingGame } from "../services/gen/src/drawing-service.js";

const imageArgument = process.argv[2];
if (!imageArgument) {
  throw new Error("Usage: npm run scan -- <path-to-image> [--out gamespec.json] [--playable-out game.json]");
}
if (!process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY is missing; add it to .env");
}

const mimeTypes: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};
const imagePath = resolve(imageArgument);
const mimeType = mimeTypes[extname(imagePath).toLowerCase()];
if (!mimeType) {
  throw new Error("Image must be a GIF, JPEG, PNG, or WebP file");
}

const image = await readFile(imagePath);
const imageUrl = `data:${mimeType};base64,${image.toString("base64")}`;
const safetyId = createHash("sha256")
  .update(`inkling-local:${process.env.USER ?? "anonymous"}`)
  .digest("hex");
const calls: RequestTrace[] = [];
const outputFlag = process.argv.indexOf("--out");
const outputPath = outputFlag >= 0 ? process.argv[outputFlag + 1] : undefined;
if (outputFlag >= 0 && !outputPath) {
  throw new Error("--out requires a JSON file path");
}
const playableOutputFlag = process.argv.indexOf("--playable-out");
const playableOutputPath = playableOutputFlag >= 0 ? process.argv[playableOutputFlag + 1] : undefined;
if (playableOutputFlag >= 0 && !playableOutputPath) {
  throw new Error("--playable-out requires a JSON file path");
}

const generated = await generateDrawingGame(
  {
    image: imageUrl,
    safetyId,
    context: { capture_surface: "paper", local_cli: true },
  },
  {
    onRequest(trace) {
      calls.push(trace);
    },
  },
);
const result = generated.scan;

console.log("GameSpec");
console.log(JSON.stringify(result.gameSpec, null, 2));
if (outputPath) {
  const resolvedOutput = resolve(outputPath);
  await writeFile(resolvedOutput, `${JSON.stringify(result.gameSpec, null, 2)}\n`, "utf8");
  console.log(`\nSaved GameSpec to ${resolvedOutput}`);
}
if (playableOutputPath) {
  const resolvedPlayableOutput = resolve(playableOutputPath);
  await writeFile(resolvedPlayableOutput, `${JSON.stringify(generated.playableGame, null, 2)}\n`, "utf8");
  console.log(`Saved playable game with original artwork to ${resolvedPlayableOutput}`);
}
console.log("\nExecuted calls");
for (const call of calls) {
  console.log(`${call.callId}\t${call.model}\t${call.effort}`);
}
