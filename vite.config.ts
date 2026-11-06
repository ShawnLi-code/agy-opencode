import { defineConfig } from "vite";
import { gui } from "@opencode/plugin/gui/vite";

// Builds the desktop GUI bundle: one CommonJS file at
// dist/gui-experimental.cjs, the file the `./gui-experimental` export points
// at. The app provides solid-js / @opencode/plugin/gui / effect, so they stay
// external.
export default defineConfig({
  plugins: [gui({ entry: "src/gui.tsx", outFile: "dist/gui-experimental.cjs" })],
  build: { minify: false, sourcemap: false },
});
