import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

/**
 * Entry discovery and config writing for `init`. Deliberately plain
 * TypeScript with no Ink import: the wizard's view is replaceable, this logic
 * is what the tests exercise.
 */

/** Ordered by how likely each is to be the module that assembles the app. */
const CANDIDATES = [
  "src/app.ts",
  "src/app.tsx",
  "src/index.ts",
  "src/server.ts",
  "src/runtime.ts",
  "src/capabilities.ts",
  "src/capabilities/index.ts",
  "src/registry.ts",
  "src/agent.ts",
  "app.ts",
  "index.ts",
  "dist/app.js",
  "dist/index.js",
];

export function discoverEntries(cwd: string): string[] {
  return CANDIDATES.filter((candidate) => existsSync(resolve(cwd, candidate)));
}

export type AgentConfig = { entry?: string; export?: string; snapshot?: string };

export function readAgentConfig(cwd: string): AgentConfig {
  try {
    const pkg = JSON.parse(readFileSync(resolve(cwd, "package.json"), "utf8")) as {
      orpcAgent?: AgentConfig;
    };
    return pkg.orpcAgent ?? {};
  } catch {
    return {};
  }
}

/**
 * Merges into `orpcAgent` rather than replacing it, so a hand-set `snapshot`
 * path survives a re-run. Returns the path written, for the wizard to show.
 */
export function writeAgentConfig(cwd: string, config: AgentConfig): string {
  const path = resolve(cwd, "package.json");
  const raw = readFileSync(path, "utf8");
  const pkg = JSON.parse(raw) as Record<string, unknown> & { orpcAgent?: AgentConfig };
  pkg.orpcAgent = { ...pkg.orpcAgent, ...config };
  // Two-space, trailing newline: what npm itself writes.
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  return relative(cwd, path) || "package.json";
}

export function hasScript(cwd: string, name: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(resolve(cwd, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    return typeof pkg.scripts?.[name] === "string";
  } catch {
    return false;
  }
}

export function addScript(cwd: string, name: string, command: string): void {
  const path = resolve(cwd, "package.json");
  const pkg = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> & {
    scripts?: Record<string, string>;
  };
  pkg.scripts = { ...pkg.scripts, [name]: command };
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
}
