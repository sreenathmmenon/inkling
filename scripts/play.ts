import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createServer } from "vite";

import { findProjectRoot } from "../runner/spec.js";

const projectRoot = findProjectRoot();
const requestedPath = process.argv[2] ?? "examples/live-scan-gamespec.json";
const specPath = resolve(projectRoot, requestedPath);
let gameSpec: unknown = null;

try {
  gameSpec = JSON.parse(await readFile(specPath, "utf8")) as unknown;
} catch (error) {
  console.warn(`Could not load ${specPath}; Lane A will use its playable fallback.`);
  console.warn(String(error));
}

const server = await createServer({
  root: resolve(projectRoot, "apps/client"),
  clearScreen: false,
  define: {
    __INKLING_GAMESPEC__: JSON.stringify(gameSpec),
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
});

await server.listen();
console.log(`GameSpec: ${specPath}`);
server.printUrls();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server.close().finally(() => process.exit(0));
  });
}
