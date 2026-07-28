#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Committed launcher. `bin` cannot point straight at `dist/cli.js`: package
 * managers link binaries at install time, which in a monorepo happens before
 * anything is built, and a bin whose target does not exist yet is silently
 * skipped. This file always exists, so the link always gets made.
 */
const entry = new URL("../dist/cli.js", import.meta.url);

if (!existsSync(fileURLToPath(entry))) {
  process.stderr.write(
    "orpc-agent: this checkout has no build output — run `pnpm build` first.\n",
  );
  // 2 is the CLI's "could not run", as opposed to 1 for drift.
  process.exit(2);
}

await import(entry.href);
