import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // switches for features built but off by default (see src/lib/features.ts)
  define: { __VS_RECEIPTS__: JSON.stringify(process.env.VITE_RECEIPTS === "1") },
  server: {
    port: 5196,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: false } },
  },
  preview: { port: 5197, strictPort: true, proxy: { "/api": "http://127.0.0.1:8787" } },
  worker: { format: "es" },
  build: {
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 2500,
    // scripts/prerender.mjs reads it to link each prerendered page's own styles (then deletes it)
    manifest: true,
  },
});
