import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { AgentRuntime, CapabilityRegistry } from "@orpc-agent/core";
import { buildSnapshot, runtimeReportsPolicies, type SnapshotSource } from "./snapshot";
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

/**
 * A runtime is a strictly better source than the registry it wraps: same
 * capabilities, plus the runtime-level policies. Prefer it wherever both are
 * on offer.
 */
function sourceOf(value: unknown): SnapshotSource | undefined {
  if (isRuntimeLike(value)) return value;
  if (isRegistryLike(value)) return value;
  return undefined;
}

function registryOf(source: SnapshotSource): CapabilityRegistry {
  return isRuntimeLike(source) ? source.registry : (source as CapabilityRegistry);
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

  // Exporting both a registry and the runtime built over it is the ordinary
  // shape of an application module, and it is not ambiguous: every candidate
  // describes the same capabilities. Take the runtime — it carries the
  // runtime-level policies too. Genuinely different registries still ask.
  const distinct = new Set(matches.map((m) => registryOf(m.source)));
  if (distinct.size > 1) {
    fail(
      11,
      `${entryPath} exports more than one capability registry`,
      `candidates: ${matches.map((m) => m.name).join(", ")}. Pass --export <name> to choose.`,
    );
  }
  source = (matches.find((m) => isRuntimeLike(m.source)) ?? matches[0]!).source;
}

const entrySource: EntrySource = !isRuntimeLike(source!)
  ? "registry"
  : runtimeReportsPolicies(source)
    ? "runtime"
    : "runtime-unreported";

/**
 * Reading the registry while the same module also exports a runtime over it is
 * almost always an accident, and a costly one: the runtime-level policies go
 * unrecorded. Reported, not enforced — pointing at the registry can be
 * deliberate.
 */
const runtimeAvailableAs =
  entrySource === "registry"
    ? Object.entries(moduleExports).find(
        ([, value]) =>
          isRuntimeLike(value) && value.registry === (source as CapabilityRegistry),
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
