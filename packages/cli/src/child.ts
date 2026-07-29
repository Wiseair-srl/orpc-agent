import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { AgentGovernance, AgentRuntime, CapabilityRegistry } from "@orpc-agent/core";
import { buildSnapshot, governanceOf, type SnapshotSource } from "./snapshot";
import type { EntrySource } from "./types";

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

function isRuntimeLike(value: unknown): value is AgentRuntime<unknown> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.invoke === "function" && isRegistryLike(candidate.registry);
}

/** A value from `defineGovernance`: a registry plus a policy manifest. */
function isGovernanceLike(value: unknown): value is AgentGovernance {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return Array.isArray(candidate.manifest) && isRegistryLike(candidate.registry);
}

function sourceOf(value: unknown): SnapshotSource | undefined {
  if (isGovernanceLike(value)) return value;
  if (isRuntimeLike(value)) return value;
  if (isRegistryLike(value)) return value;
  return undefined;
}

function registryOf(source: SnapshotSource): CapabilityRegistry {
  return isGovernanceLike(source) || isRuntimeLike(source)
    ? source.registry
    : (source as CapabilityRegistry);
}

/**
 * Ranked by how much of the governed surface each form carries. A governance
 * is the declared contract itself; a runtime carries the one it was built
 * from; a bare registry carries no policies at all.
 */
function rank(source: SnapshotSource): number {
  if (isGovernanceLike(source)) return 2;
  if (isRuntimeLike(source)) return 1;
  return 0;
}

let source: SnapshotSource | undefined;

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
  source = sourceOf(value);
  if (!source) {
    fail(11, `export "${options.exportName}" is not a capability registry or an agent runtime`);
  }
} else {
  const matches: { name: string; source: SnapshotSource }[] = [];
  for (const [name, value] of Object.entries(moduleExports)) {
    const candidate = sourceOf(value);
    if (candidate) matches.push({ name, source: candidate });
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

  // Exporting a governance, the registry it names, and the runtimes built
  // over it is the ordinary shape of an application module, and it is not
  // ambiguous: every candidate describes the same capabilities. Take the one
  // carrying the most governance. Genuinely different registries still ask.
  const distinct = new Set(matches.map((m) => registryOf(m.source)));
  if (distinct.size > 1) {
    fail(
      11,
      `${entryPath} exports more than one capability registry`,
      `candidates: ${matches.map((m) => m.name).join(", ")}. Pass --export <name> to choose.`,
    );
  }
  source = matches.reduce((best, m) => (rank(m.source) > rank(best.source) ? m : best)).source;
}

const entrySource: EntrySource = isGovernanceLike(source!)
  ? "governance"
  : !isRuntimeLike(source!)
    ? "registry"
    : governanceOf(source)
      ? "runtime"
      : "runtime-unreported";

/**
 * Reading a value that carries no policies while the same module exports one
 * that does is almost always an accident, and a costly one. Reported, not
 * enforced — pointing at the registry can be deliberate.
 */
const runtimeAvailableAs =
  entrySource === "registry"
    ? Object.entries(moduleExports).find(
        ([, value]) =>
          (isGovernanceLike(value) || isRuntimeLike(value)) &&
          value.registry === (source as CapabilityRegistry),
      )?.[0]
    : undefined;

try {
  const snapshot = buildSnapshot(source!, { descriptions: options.descriptions !== false });
  writeFileSync(
    outFile,
    JSON.stringify({ ok: true, snapshot, entrySource, runtimeAvailableAs }),
  );
} catch (error) {
  fail(
    12,
    "could not build the snapshot",
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
}

// The app's top-level code may hold the loop open; the work is done.
process.exit(0);
