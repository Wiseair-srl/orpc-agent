import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@orpc-agent/core/schema": resolve(import.meta.dirname, "../core/src/schema/index.ts"),
      "@orpc-agent/core": resolve(import.meta.dirname, "../core/src/index.ts"),
    },
  },
  test: {
    name: "cli",
    include: ["test/**/*.test.ts"],
  },
});
