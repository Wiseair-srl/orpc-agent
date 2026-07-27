import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const root = dirname(fileURLToPath(import.meta.url));
const server = `http://localhost:${process.env.PORT ?? 3000}`;

export default defineConfig({
  root,
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: {
      "/api": server,
      "/rpc": server,
    },
    fs: {
      // The typed oRPC client imports types from ../src; the monorepo's
      // packages are only ever imported as types, but allow the repo root
      // so Vite can serve source files during dev if needed.
      allow: [dirname(dirname(dirname(root)))],
    },
  },
});
