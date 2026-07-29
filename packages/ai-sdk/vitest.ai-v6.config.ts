import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config";

/**
 * The `ai@6` leg of the two-major matrix. The peer range is
 * `^5.0.0 || ^6.0.0`, so the same source and the same suite must pass against
 * both — `ai-v6` and `@ai-sdk/provider-v3` are aliased devDependencies, so the
 * leg is lockfile-pinned rather than a network install in CI.
 *
 * Not named `vitest.config.ts`, so the root project glob
 * (`packages/*​/vitest.config.ts`) keeps `pnpm test` on the v5 leg; this one
 * runs via `pnpm --filter @orpc-agent/ai-sdk test:ai-v6`.
 */
export default mergeConfig(
  base,
  defineConfig({
    resolve: {
      alias: {
        // Matches `ai` and `ai/*` only (not `ai-v6`, not `@ai-sdk/*`), so
        // `ai-v6`'s own dependencies still resolve from its own tree.
        ai: "ai-v6",
        "@ai-sdk/provider": "@ai-sdk/provider-v3",
      },
    },
    test: {
      name: "ai-sdk (ai v6)",
      env: { ORPC_AGENT_AI_MAJOR: "6" },
    },
  }),
);
