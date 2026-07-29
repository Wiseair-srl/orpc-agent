import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@orpc-agent/core/schema": resolve(import.meta.dirname, "../core/src/schema/index.ts"),
      "@orpc-agent/core": resolve(import.meta.dirname, "../core/src/index.ts"),
      "@orpc-agent/testing": resolve(import.meta.dirname, "../testing/src/index.ts"),
    },
  },
  test: {
    name: "ai-sdk",
    include: ["test/**/*.test.ts"],
    // Which half of the two-major matrix this is. The suite asserts the `ai`
    // it actually loaded matches, so an alias that silently stops working
    // fails the leg instead of re-running v5 twice.
    env: { ORPC_AGENT_AI_MAJOR: "5" },
  },
});
