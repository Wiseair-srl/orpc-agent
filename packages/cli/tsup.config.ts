import { defineConfig } from "tsup";

export default defineConfig({
  // `child` is a separate entry on purpose: it is spawned as its own process,
  // never imported by the parent (see src/load.ts).
  entry: { index: "src/index.ts", cli: "src/cli.ts", child: "src/child.ts" },
  format: ["esm"],
  dts: { entry: { index: "src/index.ts" } },
  sourcemap: true,
  clean: true,
  target: "es2022",
  // ink and react are optional and dynamically imported (src/ui): they must
  // stay external so a missing install fails the `import()`, not the build.
  external: ["@orpc-agent/core", "ink", "react", "react/jsx-runtime"],
});
