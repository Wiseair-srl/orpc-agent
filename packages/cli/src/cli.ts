#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { snapshotJson } from "./canonical";
import { diffSnapshots } from "./diff";
import { discoverEntries, readAgentConfig } from "./discover";
import { LoadError, loadSnapshot } from "./load";
// Framework-free: this module only *dynamically* imports ink, so `check`
// pulls in no rendering dependency by reaching it.
import { interactive, renderInventoryInk, runInitUi } from "./ui/index";
import {
  renderChanges,
  renderGithub,
  renderInventory,
  renderMarkdown,
  supportsColor,
} from "./render";
import type { CapabilitySnapshot, Change } from "./types";

/**
 * Exit codes are part of the contract: 0 clean · 1 drift · 2 could not run.
 * CI has to tell "the inventory changed" apart from "the tool never loaded
 * the app", because the second one silently passing is how a gate rots.
 */
const EXIT_OK = 0;
const EXIT_DRIFT = 1;
const EXIT_ERROR = 2;

const DEFAULT_SNAPSHOT = "capabilities.snapshot.json";

const USAGE = `orpc-agent — capability inventory and drift gate

USAGE
  orpc-agent init      [options]      set up entry, export and the CI step
  orpc-agent inspect   [options]      print the capability inventory
  orpc-agent snapshot  [options]      write the snapshot file (also: update it)
  orpc-agent check     [options]      compare the app against the snapshot file

OPTIONS
  --entry <path>       application module exporting a registry or an AgentRuntime
  --export <name>      which export to read (required when several match)
  --snapshot <path>    snapshot file (default: ${DEFAULT_SNAPSHOT})
  -o, --out <path>     snapshot output path; "-" for stdout
  --fail-on <mode>     check: "any" (default) or "widening"
  --format <format>    check: human (default) | md | github
  --json               inspect: print the snapshot as JSON instead of a table
  --plain              never use the interactive renderer (CI-safe output)
  --no-descriptions    omit capability descriptions from the snapshot
  --import <module>    preload a module in the loader process (e.g. tsx)
  --timeout <ms>       loader timeout (default: 30000)
  --cwd <path>         run as if from this directory
  -h, --help           show this
  -v, --version        show the version

CONFIG
  Defaults for --entry, --export and --snapshot may live in package.json:
    { "orpcAgent": { "entry": "src/app.ts", "export": "capabilities" } }
`;

type Flags = {
  command: string | undefined;
  entry?: string;
  export?: string;
  snapshot?: string;
  out?: string;
  failOn: "any" | "widening";
  format: "human" | "md" | "github";
  json: boolean;
  plain: boolean;
  descriptions: boolean;
  import?: string;
  timeout: number;
  cwd: string;
  help: boolean;
  version: boolean;
};

function parseArgs(argv: string[]): Flags {
  const flags: Flags = {
    command: undefined,
    failOn: "any",
    format: "human",
    json: false,
    plain: false,
    descriptions: true,
    timeout: 30_000,
    cwd: process.cwd(),
    help: false,
    version: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const next = () => {
      const value = argv[index + 1];
      // A lone "-" is a value (stdout), not a flag.
      if (value === undefined || (value.startsWith("-") && value !== "-")) {
        throw new UsageError(`${argument} needs a value`);
      }
      index += 1;
      return value;
    };

    switch (argument) {
      case "-h":
      case "--help":
        flags.help = true;
        break;
      case "-v":
      case "--version":
        flags.version = true;
        break;
      case "--entry":
        flags.entry = next();
        break;
      case "--export":
        flags.export = next();
        break;
      case "--snapshot":
        flags.snapshot = next();
        break;
      case "-o":
      case "--out":
        flags.out = next();
        break;
      case "--fail-on": {
        const value = next();
        if (value !== "any" && value !== "widening") {
          throw new UsageError(`--fail-on must be "any" or "widening" (got "${value}")`);
        }
        flags.failOn = value;
        break;
      }
      case "--format": {
        const value = next();
        if (value !== "human" && value !== "md" && value !== "github") {
          throw new UsageError(`--format must be human, md or github (got "${value}")`);
        }
        flags.format = value;
        break;
      }
      case "--json":
        flags.json = true;
        break;
      case "--plain":
        flags.plain = true;
        break;
      case "--no-descriptions":
        flags.descriptions = false;
        break;
      case "--import":
        flags.import = next();
        break;
      case "--timeout": {
        const value = Number(next());
        if (!Number.isFinite(value) || value <= 0) {
          throw new UsageError("--timeout must be a positive number of milliseconds");
        }
        flags.timeout = value;
        break;
      }
      case "--cwd":
        flags.cwd = resolve(next());
        break;
      default:
        if (argument.startsWith("-")) throw new UsageError(`unknown option "${argument}"`);
        if (flags.command) throw new UsageError(`unexpected argument "${argument}"`);
        flags.command = argument;
    }
  }

  return flags;
}

class UsageError extends Error {}

type FileConfig = { entry?: string; export?: string; snapshot?: string };

function readConfig(cwd: string): FileConfig {
  try {
    const pkg = JSON.parse(readFileSync(resolve(cwd, "package.json"), "utf8")) as {
      orpcAgent?: FileConfig;
    };
    return pkg.orpcAgent ?? {};
  } catch {
    return {};
  }
}

/**
 * Version 1 files are still accepted: they predate the `runtime` key, so they
 * simply read as "runtime policies never observed", which is what they were.
 * Rejecting them would break every committed snapshot on upgrade.
 */
function readSnapshotFile(path: string): CapabilitySnapshot {
  const contents = readFileSync(path, "utf8");
  const parsed = JSON.parse(contents) as CapabilitySnapshot;
  if ((parsed.version !== 1 && parsed.version !== 2) || !Array.isArray(parsed.capabilities)) {
    throw new Error(
      `${path} is not a capability snapshot this version can read ` +
        `(got version ${JSON.stringify(parsed.version)}, expected 1 or 2)`,
    );
  }
  return parsed;
}

async function main(argv: string[]): Promise<number> {
  const flags = parseArgs(argv);

  if (flags.version) {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    process.stdout.write(`${pkg.version}\n`);
    return EXIT_OK;
  }
  if (flags.help) {
    process.stdout.write(USAGE);
    return EXIT_OK;
  }
  if (!flags.command) {
    process.stderr.write(USAGE);
    return EXIT_ERROR;
  }

  const config = readConfig(flags.cwd);
  const entry = flags.entry ?? config.entry;
  const exportName = flags.export ?? config.export;
  const snapshotPath = resolveFrom(flags.cwd, flags.snapshot ?? config.snapshot ?? DEFAULT_SNAPSHOT);

  if (!["init", "inspect", "snapshot", "check"].includes(flags.command)) {
    throw new UsageError(`unknown command "${flags.command}"`);
  }

  // Before the entry check: init exists precisely to work out what the entry is.
  if (flags.command === "init") {
    return runInit(flags, entry, snapshotPath);
  }

  if (!entry) {
    throw new UsageError(
      'no entry module — pass --entry <path> or set { "orpcAgent": { "entry": … } } in package.json',
    );
  }

  const { snapshot, entrySource, runtimeAvailableAs } = await loadSnapshot({
    entry,
    ...(exportName ? { exportName } : {}),
    descriptions: flags.descriptions,
    timeoutMs: flags.timeout,
    cwd: flags.cwd,
    ...(flags.import ? { importSpecifier: flags.import } : {}),
  });

  // stderr, so it survives `--json`, `-o -`, and a piped report.
  if (runtimeAvailableAs) {
    process.stderr.write(
      `orpc-agent: read the registry, but "${runtimeAvailableAs}" in the same module is an ` +
        "agent runtime over it. Runtime-level policies are NOT recorded this way. " +
        `Use --export ${runtimeAvailableAs} to include them.\n`,
    );
  }

  if (flags.command === "inspect") {
    if (flags.json) {
      process.stdout.write(snapshotJson(snapshot));
      return EXIT_OK;
    }
    // Rich view for a human at a terminal; plain text everywhere else — piped,
    // redirected, in CI, or with the optional UI dependencies absent.
    if (!flags.plain && interactive(process.stdout)) {
      if (await renderInventoryInk(snapshot, entrySource)) return EXIT_OK;
    }
    process.stdout.write(
      `${renderInventory(snapshot, { color: supportsColor(process.stdout) }, entrySource)}\n`,
    );
    return EXIT_OK;
  }

  if (flags.command === "snapshot") {
    const serialized = snapshotJson(snapshot);
    if (flags.out === "-") {
      process.stdout.write(serialized);
      return EXIT_OK;
    }
    const target = flags.out ? resolveFrom(flags.cwd, flags.out) : snapshotPath;
    writeFileSync(target, serialized);
    process.stderr.write(`wrote ${target} (${snapshot.capabilities.length} capabilities)\n`);
    return EXIT_OK;
  }

  let committed: CapabilitySnapshot;
  try {
    committed = readSnapshotFile(snapshotPath);
  } catch (error) {
    const reason =
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "was not found"
        : `could not be read (${(error as Error).message})`;
    process.stderr.write(
      `orpc-agent check: ${snapshotPath} ${reason}.\n` +
        `Create it with: orpc-agent snapshot --entry ${entry}\n`,
    );
    return EXIT_ERROR;
  }

  const changes = diffSnapshots(committed, snapshot);
  writeReport(changes, flags.format);

  // The committed baseline predates runtime-policy recording. That is classed
  // neutral — the application did not change, the tool started looking — so
  // `--fail-on widening` passes. It must not pass *quietly*: until the
  // snapshot is rewritten, deleting a runtime policy is still invisible.
  if (!committed.runtime && snapshot.runtime) {
    process.stderr.write(
      `\norpc-agent: ${snapshotPath} predates runtime-policy recording. ` +
        `${snapshot.runtime.policies.length} runtime ` +
        `${snapshot.runtime.policies.length === 1 ? "policy is" : "policies are"} ` +
        "configured and NOT covered by this gate yet. " +
        `Run: orpc-agent snapshot --entry ${entry}\n`,
    );
  }

  if (changes.length === 0) return EXIT_OK;
  const failing =
    flags.failOn === "widening" ? changes.filter((c) => c.kind === "widening") : changes;
  if (failing.length === 0) return EXIT_OK;

  if (flags.format === "human") {
    process.stderr.write(
      `\nUpdate the snapshot in this change: orpc-agent snapshot --entry ${entry}\n`,
    );
  }
  return EXIT_DRIFT;
}

/**
 * The one interactive command. It refuses rather than degrades: a wizard with
 * no keyboard is not a wizard, and silently writing a guessed config would be
 * worse than saying what to pass.
 */
async function runInit(flags: Flags, entry: string | undefined, snapshotPath: string): Promise<number> {
  const existing = readAgentConfig(flags.cwd);
  const candidates = entry ? [entry] : discoverEntries(flags.cwd);

  if (candidates.length === 0) {
    process.stderr.write(
      "orpc-agent init: found no candidate entry module.\n" +
        "Pass --entry <path> pointing at the module that exports your registry or " +
        "AgentRuntime.\n",
    );
    return EXIT_ERROR;
  }

  if (!interactive(process.stdin) || !interactive(process.stdout)) {
    process.stderr.write(
      "orpc-agent init needs an interactive terminal.\n" +
        `Set it by hand instead: { "orpcAgent": { "entry": "${candidates[0]}" } } in ` +
        "package.json.\n",
    );
    return EXIT_ERROR;
  }

  if (existing.entry) {
    process.stderr.write(
      `orpc-agent init: package.json already configures entry "${existing.entry}"` +
        `${existing.export ? ` (export ${existing.export})` : ""}. Re-running will update it.\n\n`,
    );
  }

  const result = await runInitUi({
    cwd: flags.cwd,
    candidates,
    snapshotPath: flags.snapshot ?? existing.snapshot ?? DEFAULT_SNAPSHOT,
  });

  if (!result.ok) {
    process.stderr.write(
      "orpc-agent init: the interactive UI needs the optional dependencies.\n" +
        "Install them with: pnpm add -D ink react\n" +
        `Or set it by hand: { "orpcAgent": { "entry": "${candidates[0]}" } } in package.json.\n`,
    );
    return EXIT_ERROR;
  }
  return result.code;
}

function writeReport(changes: Change[], format: Flags["format"]): void {
  if (format === "github") {
    if (changes.length > 0) process.stdout.write(`${renderGithub(changes)}\n`);
    return;
  }
  if (format === "md") {
    process.stdout.write(`${renderMarkdown(changes)}\n`);
    return;
  }
  process.stdout.write(`${renderChanges(changes, { color: supportsColor(process.stdout) })}\n`);
}

function resolveFrom(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`orpc-agent: ${error.message}\n\n${USAGE}`);
  } else if (error instanceof LoadError) {
    process.stderr.write(
      `orpc-agent: ${error.message}\n${error.detail ? `\n${error.detail}\n` : ""}`,
    );
  } else {
    process.stderr.write(`orpc-agent: ${(error as Error).message}\n`);
  }
  process.exitCode = EXIT_ERROR;
}
