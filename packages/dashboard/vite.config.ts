import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // `agentrec ui --port 4040` serves the API during development.
      "/api": "http://127.0.0.1:4040",
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
