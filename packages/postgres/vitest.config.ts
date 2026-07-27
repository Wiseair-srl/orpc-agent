import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "postgres",
    include: ["test/**/*.test.ts"],
  },
});
