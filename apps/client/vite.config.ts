import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              // Phaser is by far the heaviest dependency and is shared by the
              // lazy player and the browser replay harness. Naming its chunk
              // keeps the >500 kB warning attributed to the engine itself
              // instead of whichever small runtime module the splitter would
              // otherwise name the shared chunk after (presentation-contract).
              name: "phaser",
              test: /[\\/]node_modules[\\/]phaser[\\/]/,
            },
          ],
        },
      },
    },
  },
});
