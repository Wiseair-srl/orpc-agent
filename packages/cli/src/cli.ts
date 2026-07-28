#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { snapshotJson } from "./canonical";
import { diffSnapshots } from "./diff";
import { LoadError, loadSnapshot } from "./load";
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
  orpc-agent inspect   [options]      print the capability inventory
  orpc-agent snapshot  [options]      write the snapshot file (also: update it)
  orpc-agent check     [options]      compare the app against the snapshot file

OPTIONS
  --entry <path>       application module exporting a capability registry
  --export <name>      which export to read (required when several match)
  --snapshot <path>    snapshot file (default: ${DEFAULT_SNAPSHOT})
  -o, --out <path>     snapshot output path; "-" for stdout
  --fail-on <mode>     check: "any" (default) or "widening"
  --format <format>    check: human (default) | md | github
  --json               inspect: print the snapshot as JSON instead of a table
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

function readSnapshotFile(path: string): CapabilitySnapshot {
  const contents = readFileSync(path, "utf8");
  const parsed = JSON.parse(contents) as CapabilitySnapshot;
  if (parsed.version !== 1 || !Array.isArray(parsed.capabilities)) {
    throw new Error(`${path} is not a capability snapshot (expected version 1)`);
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

  if (!["inspect", "snapshot", "check"].includes(flags.command)) {
    throw new UsageError(`unknown command "${flags.command}"`);
  }
  if (!entry) {
    throw new UsageError(
      'no entry module — pass --entry <path> or set { "orpcAgent": { "entry": … } } in package.json',
    );
  }

  const { snapshot } = await loadSnapshot({
    entry,
    ...(exportName ? { exportName } : {}),
    descriptions: flags.descriptions,
    timeoutMs: flags.timeout,
    cwd: flags.cwd,
    ...(flags.import ? { importSpecifier: flags.import } : {}),
  });

  if (flags.command === "inspect") {
    process.stdout.write(
      flags.json
        ? snapshotJson(snapshot)
        : `${renderInventory(snapshot, { color: supportsColor(process.stdout) })}\n`,
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
