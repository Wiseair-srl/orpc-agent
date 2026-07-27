import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

const packages = resolve(import.meta.dirname, "../../packages");

export default defineConfig({
  resolve: {
    alias: {
      "@orpc-agent/core/schema": resolve(packages, "core/src/schema/index.ts"),
      "@orpc-agent/core": resolve(packages, "core/src/index.ts"),
      "@orpc-agent/testing": resolve(packages, "testing/src/index.ts"),
      "@orpc-agent/ai-sdk": resolve(packages, "ai-sdk/src/index.ts"),
      "@orpc-agent/mcp": resolve(packages, "mcp/src/index.ts"),
      "@orpc-agent/opentelemetry": resolve(packages, "opentelemetry/src/index.ts"),
    },
  },
  test: {
    name: "customer-support",
    include: ["test/**/*.test.ts"],
  },
});
