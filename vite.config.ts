import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const rendererPort = Number(process.env.MEMFORGE_RENDERER_PORT ?? 5173);
const apiTarget = process.env.MEMFORGE_RENDERER_API_TARGET ?? "http://127.0.0.1:8787";

export default defineConfig({
  base: "./",
  plugins: [react()],
  root: ".",
  build: {
    outDir: "dist/renderer",
    emptyOutDir: false
  },
  server: {
    host: "127.0.0.1",
    port: rendererPort,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true
      }
    }
  }
});
