import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const packageRoot = new URL("../packages/core/", import.meta.url).pathname;
const require = createRequire(join(packageRoot, "package.json"));
const { build } = createRequire(require.resolve("tsup"))("esbuild");
const output = await mkdtemp(join(tmpdir(), "orpc-agent-bundle-"));
try {
  const file = join(output, "lambda.mjs");
  await build({
    stdin: { contents: `
      import { registerZodSchemaConverter } from "./src/schema/zod.ts";
      import { agentProcedure, createCapabilityRegistry } from "./src/index.ts";
      import { os } from "@orpc/server";
      import { z } from "zod";
      registerZodSchemaConverter();
      const p = agentProcedure(os).meta({agent:{description:"Bundled", expose:{aiSdk:true}, sideEffect:"read", risk:"low"}}).input(z.object({id:z.string()})).handler(({input})=>input);
      if (createCapabilityRegistry({p}).ids()[0] !== "p") throw new Error("Bundle registry failed");
    `, resolveDir: packageRoot },
    outfile: file, bundle: true, platform: "node", format: "esm", target: "node20", logLevel: "silent",
  });
  // The output directory has no node_modules. All optional schema dependencies must be bundled.
  execFileSync(process.execPath, [file], { cwd: output, stdio: "pipe" });
  await build({ entryPoints: [resolve(packageRoot, "src/client/index.ts"), resolve(packageRoot, "src/http.ts")], outdir: join(output, "browser"), bundle: true, platform: "browser", format: "esm", logLevel: "silent" });
  process.stdout.write("Distributed bundles OK: standalone Lambda schema conversion; browser client + HTTP entry\n");
} finally { await rm(output, { recursive: true, force: true }); }
