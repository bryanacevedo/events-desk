import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  test: { globalSetup: ["tests/pg-cleanup.ts"] },
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": "http://localhost:8787" } },
  build: { outDir: "dist", emptyOutDir: true },
});
