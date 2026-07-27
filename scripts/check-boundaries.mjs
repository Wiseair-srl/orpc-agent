#!/usr/bin/env node
/**
 * Package-boundary rules (docs/architecture/package-boundaries.md):
 * - core imports no adapter, no provider/protocol SDK, no OpenTelemetry;
 * - adapters import core + exactly their own protocol SDK (peer), never
 *   another adapter;
 * - testing imports core only (no protocol SDKs, no network);
 * - core's package.json lists no runtime dependency on ai, MCP SDK, or OTel.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const failures = [];

const FORBIDDEN_IMPORTS = {
  core: [/^ai($|\/)/, /^@modelcontextprotocol\//, /^@opentelemetry\//, /^@orpc-agent\/(?!core)/],
  "ai-sdk": [/^@modelcontextprotocol\//, /^@opentelemetry\//, /^@orpc-agent\/(?!core)/],
  mcp: [/^ai($|\/)/, /^@opentelemetry\//, /^@orpc-agent\/(?!core)/],
  opentelemetry: [/^ai($|\/)/, /^@modelcontextprotocol\//, /^@orpc-agent\/(?!core)/],
  testing: [
    /^ai($|\/)/,
    /^@modelcontextprotocol\//,
    /^@opentelemetry\//,
    /^@orpc-agent\/(?!core)/,
  ],
  // Driver-agnosticism is an ADR-013 bound: src never imports a database
  // driver (tests may — pglite and pg are devDependencies only).
  postgres: [
    /^ai($|\/)/,
    /^@modelcontextprotocol\//,
    /^@opentelemetry\//,
    /^@orpc-agent\/(?!core)/,
    /^pg($|\/)/,
    /^@electric-sql\//,
  ],
};

function* walkFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) yield* walkFiles(full);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry)) yield full;
  }
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[^"'`]*?from\s*["']([^"']+)["']|(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;

for (const [pkg, forbidden] of Object.entries(FORBIDDEN_IMPORTS)) {
  const srcDir = join(root, "packages", pkg, "src");
  if (!existsSync(srcDir)) continue;
  for (const file of walkFiles(srcDir)) {
    const content = readFileSync(file, "utf8");
    for (const match of content.matchAll(IMPORT_RE)) {
      const specifier = match[1] ?? match[2];
      if (!specifier || specifier.startsWith(".") || specifier.startsWith("node:")) continue;
      for (const pattern of forbidden) {
        if (pattern.test(specifier)) {
          failures.push(
            `${relative(root, file)}: forbidden import "${specifier}" (boundary rule for ${pkg})`,
          );
        }
      }
    }
  }
}

// core package.json must not list adapter/protocol SDKs as runtime deps.
const corePkgPath = join(root, "packages", "core", "package.json");
if (existsSync(corePkgPath)) {
  const corePkg = JSON.parse(readFileSync(corePkgPath, "utf8"));
  const runtimeDeps = Object.keys(corePkg.dependencies ?? {});
  for (const dep of runtimeDeps) {
    if (/^ai$|^@modelcontextprotocol\/|^@opentelemetry\//.test(dep)) {
      failures.push(`packages/core/package.json: forbidden runtime dependency "${dep}"`);
    }
  }
}

// postgres package must not list a database driver as a runtime dependency
// (ADR-013: the query function is the seam; drivers are the app's choice).
const postgresPkgPath = join(root, "packages", "postgres", "package.json");
if (existsSync(postgresPkgPath)) {
  const postgresPkg = JSON.parse(readFileSync(postgresPkgPath, "utf8"));
  const runtimeDeps = Object.keys({
    ...postgresPkg.dependencies,
    ...postgresPkg.peerDependencies,
  });
  for (const dep of runtimeDeps) {
    if (/^pg$|^@electric-sql\//.test(dep)) {
      failures.push(`packages/postgres/package.json: forbidden runtime dependency "${dep}"`);
    }
  }
}

// testing package must not depend on protocol SDKs at all.
const testingPkgPath = join(root, "packages", "testing", "package.json");
if (existsSync(testingPkgPath)) {
  const testingPkg = JSON.parse(readFileSync(testingPkgPath, "utf8"));
  const allDeps = Object.keys({
    ...testingPkg.dependencies,
    ...testingPkg.peerDependencies,
  });
  for (const dep of allDeps) {
    if (/^ai$|^@modelcontextprotocol\/|^@opentelemetry\//.test(dep)) {
      failures.push(`packages/testing/package.json: forbidden dependency "${dep}"`);
    }
  }
}

if (failures.length > 0) {
  console.error("Package boundary check failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("Package boundaries OK");
