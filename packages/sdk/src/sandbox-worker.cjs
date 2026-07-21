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
      __offsets: null,
      __seed: Number(payload.seed) >>> 0,
    };
    const context = vm.createContext(sandbox, {
      codeGeneration: { strings: false, wasm: false },
      name: "inkling-behavior-sandbox",
    });
    new vm.Script(`"use strict";\n${source}`, {
      filename: "generated-behavior.js",
    }).runInContext(context, { timeout: 100 });

    // The simulation is also the recorder: every ctx.move/ctx.velocity call
    // the module makes over the full 30-second solver horizon becomes a
    // bounded, quantized offset track. Only this data — never the module
    // source — is ever executed by the runtime, the playtester, or the
    // browser replay, so all three see identical deterministic motion.
    new vm.Script(
      `
      (() => {
        const behavior = __behavior;
        if (!behavior || behavior.id !== ${JSON.stringify(payload.expectedEntityId)}) {
          // The message is model-facing feedback: naming the exact required
          // id lets a session correct itself in one round instead of guessing.
          throw new Error(
            "behavior id " + JSON.stringify(behavior && behavior.id) +
            " must be exactly " + ${JSON.stringify(JSON.stringify(payload.expectedEntityId))} +
            " (the bound entity id, not the behavior name)"
          );
        }
        let state = __seed || 1;
        const rng = () => {
          state ^= state << 13;
          state ^= state >>> 17;
          state ^= state << 5;
          return (state >>> 0) / 4294967296;
        };
        const DT = 1 / 60;
        const MAX_X = 480;
        const MAX_Y = 270;
        let offsetX = 0;
        let offsetY = 0;
        let velocityX = 0;
        let velocityY = 0;
        const clampNumber = (value, bound) => {
          const numeric = Number(value);
          if (!Number.isFinite(numeric)) return 0;
          return Math.max(-bound, Math.min(bound, numeric));
        };
        const ctx = Object.freeze({
          move(dx, dy) {
            offsetX += clampNumber(dx, MAX_X);
            offsetY += clampNumber(dy, MAX_Y);
          },
          velocity(vx, vy) {
            velocityX = clampNumber(vx, 600);
            velocityY = clampNumber(vy, 600);
          },
          spawnProjectile() {}, playSfx() {},
          setState() {}, damage() {}, win() {}, lose() {}, rng,
          get time() { return frame * DT; },
        });
        let frame = 0;
        if (typeof behavior.onSpawn === "function") behavior.onSpawn(ctx);
        __offsets = [];
        for (frame = 0; frame < 1800; frame += 1) {
          if (typeof behavior.onUpdate === "function") behavior.onUpdate(DT, ctx);
          offsetX = Math.max(-MAX_X, Math.min(MAX_X, offsetX + velocityX * DT));
          offsetY = Math.max(-MAX_Y, Math.min(MAX_Y, offsetY + velocityY * DT));
          __offsets.push([Math.round(offsetX * 10) / 10, Math.round(offsetY * 10) / 10]);
        }
        if (typeof behavior.onCollide === "function") {
          behavior.onCollide(Object.freeze({ id: "headless_fixture", role: "platform" }), ctx);
        }
      })();
      `,
      { filename: "headless-simulation.js" },
    ).runInContext(context, { timeout: 1000 });
    const offsets = Array.isArray(sandbox.__offsets) ? sandbox.__offsets : [];
    const moved = offsets.some(
      (offset) => Array.isArray(offset) && (offset[0] !== 0 || offset[1] !== 0),
    );
    process.stdout.write(JSON.stringify({
      valid: true,
      errors: [],
      track: moved
        ? {
          format: "inkling-behavior-track-v1",
          entityId: payload.expectedEntityId,
          dt: 1 / 60,
          offsets,
        }
        : null,
    }));
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ valid: false, errors: [`runtime:${String(error.message || error)}`] }),
    );
    process.exitCode = 1;
  }
});
