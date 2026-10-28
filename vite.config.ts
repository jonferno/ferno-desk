import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: "web",
  plugins: [react()],
  resolve: {
    alias: { "@shared": resolve(import.meta.dirname, "shared") },
  },
  build: { outDir: resolve(import.meta.dirname, "dist"), emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8899", "/ws": { target: "ws://localhost:8899", ws: true } },
  },
});
