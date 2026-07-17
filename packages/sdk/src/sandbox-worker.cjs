"use strict";

const vm = require("node:vm");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(input);
    const source = String(payload.source)
      .replace(/^\s*import(?:[\s\S]*?)\sfrom\s+["'][^"']+["'];?\s*$/gm, "")
      .replace(/\bexport\s+default\s+/g, "")
      .replace(/\bexport\s+/g, "");

    const sandboxMath = Object.create(Math);
    Object.defineProperty(sandboxMath, "random", {
      value() {
        throw new Error("Math.random is disabled; use ctx.rng");
      },
    });
    const sandbox = {
      Math: Object.freeze(sandboxMath),
      defineBehavior(definition) {
        if (!definition || typeof definition !== "object") {
          throw new Error("defineBehavior requires an object");
        }
        sandbox.__behavior = definition;
        return definition;
      },
      __behavior: null,
      __seed: Number(payload.seed) >>> 0,
    };
    const context = vm.createContext(sandbox, {
      codeGeneration: { strings: false, wasm: false },
      name: "inkling-behavior-sandbox",
    });
    new vm.Script(`"use strict";\n${source}`, {
      filename: "generated-behavior.js",
    }).runInContext(context, { timeout: 100 });

    new vm.Script(
      `
      (() => {
        const behavior = __behavior;
        if (!behavior || behavior.id !== ${JSON.stringify(payload.expectedEntityId)}) {
          throw new Error("behavior id does not match entity");
        }
        let state = __seed || 1;
        const rng = () => {
          state ^= state << 13;
          state ^= state >>> 17;
          state ^= state << 5;
          return (state >>> 0) / 4294967296;
        };
        const ctx = Object.freeze({
          move() {}, velocity() {}, spawnProjectile() {}, playSfx() {},
          setState() {}, damage() {}, win() {}, lose() {}, rng,
          get time() { return frame * (1 / 60); },
        });
        let frame = 0;
        if (typeof behavior.onSpawn === "function") behavior.onSpawn(ctx);
        for (frame = 0; frame < 180; frame += 1) {
          if (typeof behavior.onUpdate === "function") behavior.onUpdate(1 / 60, ctx);
        }
        if (typeof behavior.onCollide === "function") {
          behavior.onCollide(Object.freeze({ id: "headless_fixture", role: "platform" }), ctx);
        }
      })();
      `,
      { filename: "headless-simulation.js" },
    ).runInContext(context, { timeout: 250 });
    process.stdout.write(JSON.stringify({ valid: true, errors: [] }));
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ valid: false, errors: [`runtime:${String(error.message || error)}`] }),
    );
    process.exitCode = 1;
  }
});
