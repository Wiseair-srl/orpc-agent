import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "postgres",
    include: ["test/**/*.test.ts"],
    /**
     * pglite boots a WASM Postgres on the first query, and that cost lands on
     * whichever test runs first. On a contended runner it exceeds the 5s
     * default and fails a suite that is not actually slow — reproducible by
     * loading the CPU and running the full workspace suite.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
