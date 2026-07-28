import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { CapabilityRegistry } from "@orpc-agent/core";
import { buildSnapshot } from "./snapshot";

/**
 * The loader worker. Runs in its own process because importing an
 * application's entry module runs that application's top-level code: it may
 * open pools, register signal handlers, or otherwise keep the event loop
 * alive forever. Isolating it means the CLI can hard-exit and time out
 * without inheriting anything the app left open.
 *
 * Never imported by the parent — spawned. Results go to a file, not stdout,
 * so anything the app prints on import cannot corrupt them.
 *
 * argv: <entryPath> <outFile> <optionsJson>
 * exit: 0 ok · 10 module load failed · 11 no/ambiguous registry · 12 build failed
 */

const [entryPath, outFile, optionsJson] = process.argv.slice(2);

if (!entryPath || !outFile) {
  process.stderr.write("orpc-agent child: missing arguments\n");
  process.exit(12);
}

const options = JSON.parse(optionsJson ?? "{}") as {
  exportName?: string;
  descriptions?: boolean;
};

function fail(code: number, message: string, detail?: string): never {
  writeFileSync(outFile!, JSON.stringify({ ok: false, message, detail }));
  process.exit(code);
}

let moduleExports: Record<string, unknown>;
try {
  moduleExports = (await import(pathToFileURL(entryPath).href)) as Record<string, unknown>;
} catch (error) {
  fail(
    10,
    `could not import ${entryPath}`,
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
}

function isRegistryLike(value: unknown): value is CapabilityRegistry {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.inspect === "function" &&
    typeof candidate.ids === "function" &&
    typeof candidate.capabilities === "function"
  );
}

/** An AgentRuntime exposes its registry; accept it as a convenience. */
function registryOf(value: unknown): CapabilityRegistry | undefined {
  if (isRegistryLike(value)) return value;
  if (typeof value === "object" && value !== null) {
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.invoke === "function" && isRegistryLike(candidate.registry)) {
      return candidate.registry;
    }
  }
  return undefined;
}

let registry: CapabilityRegistry | undefined;

if (options.exportName) {
  const value = moduleExports[options.exportName];
  if (value === undefined) {
    fail(
      11,
      `export "${options.exportName}" not found in ${entryPath}`,
      `available exports: ${Object.keys(moduleExports).join(", ") || "(none)"}`,
    );
  }
  if (typeof value === "function") {
    // Calling it could do anything — connect, migrate, charge a card. The
    // inventory is read from a value, never produced by invoking user code.
    fail(
      11,
      `export "${options.exportName}" is a function`,
      "point --export at a capability registry or runtime value, not at a factory",
    );
  }
  registry = registryOf(value);
  if (!registry) {
    fail(11, `export "${options.exportName}" is not a capability registry or an agent runtime`);
  }
} else {
  const matches: string[] = [];
  for (const [name, value] of Object.entries(moduleExports)) {
    if (registryOf(value)) matches.push(name);
  }
  if (matches.length === 0) {
    fail(
      11,
      `no capability registry exported from ${entryPath}`,
      `exports checked: ${Object.keys(moduleExports).join(", ") || "(none)"}. ` +
        "Export the value returned by createCapabilityRegistry (or an agent runtime), " +
        "or pass --export <name>.",
    );
  }
  if (matches.length > 1) {
    fail(
      11,
      `${entryPath} exports more than one capability registry`,
      `candidates: ${matches.join(", ")}. Pass --export <name> to choose.`,
    );
  }
  registry = registryOf(moduleExports[matches[0]!]);
}

try {
  const snapshot = buildSnapshot(registry!, { descriptions: options.descriptions !== false });
  writeFileSync(outFile, JSON.stringify({ ok: true, snapshot }));
} catch (error) {
  fail(
    12,
    "could not build the snapshot",
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
}

// The app's top-level code may hold the loop open; the work is done.
process.exit(0);
