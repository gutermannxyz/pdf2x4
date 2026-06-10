import { defineConfig } from "vite";

// Reine Client-App: GS-WASM + pdf-lib laufen im Browser, nichts geht an einen Server.
export default defineConfig({
  base: "/",
  build: { outDir: "dist", target: "es2022", sourcemap: false },
  // gs.wasm (~16 MB) nicht vorab-bündeln; wird lazy via dynamic import geladen.
  optimizeDeps: { exclude: ["@jspawn/ghostscript-wasm"] },
});
