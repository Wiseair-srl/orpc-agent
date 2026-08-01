#!/usr/bin/env node
/**
 * Acceptance criterion 8: a grep-based consistency check of symbol names,
 * error codes, and event names across docs and implementation — no silent
 * drift between what the docs promise and what the code ships.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const failures = [];

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function* walk(dir, extension) {
  for (const entry of readdirSync(join(root, dir))) {
    const relative = join(dir, entry);
    if (statSync(join(root, relative)).isDirectory()) yield* walk(relative, extension);
    else if (entry.endsWith(extension)) yield relative;
  }
}

const docs = [...walk("docs", ".md")].map((p) => read(p)).join("\n");
const coreSource = [...walk("packages/core/src", ".ts")].map((p) => read(p)).join("\n");

// 1. Every error code in the docs table exists in the implementation, and
//    vice versa (the code table is closed).
const errorsDoc = read("docs/reference/errors.md");
const docCodes = new Set([...errorsDoc.matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1]));
const implErrors = read("packages/core/src/errors.ts");
const implCodes = new Set([...implErrors.matchAll(/^ {2}\| "([A-Z_]+)"/gm)].map((m) => m[1]));
for (const code of docCodes) {
  if (!implCodes.has(code)) failures.push(`error code ${code} documented but not implemented`);
}
for (const code of implCodes) {
  if (!docCodes.has(code)) failures.push(`error code ${code} implemented but not documented`);
}

// 2. Every audit event type in the docs catalog exists in the event union.
const eventsDoc = read("docs/reference/events.md");
const docEvents = new Set(
  [...eventsDoc.matchAll(/^\| `(capabilit(?:y|ies)\.[a-z_]+)` \|/gm)].map((m) => m[1]),
);
const implEvents = read("packages/core/src/events.ts");
for (const event of docEvents) {
  if (!implEvents.includes(`"${event}"`)) {
    failures.push(`audit event ${event} documented but not implemented`);
  }
}
const implEventTypes = [...implEvents.matchAll(/type: "(capabilit(?:y|ies)\.[a-z_]+)"/g)].map(
  (m) => m[1],
);
for (const event of implEventTypes) {
  if (!docEvents.has(event)) failures.push(`audit event ${event} implemented but not documented`);
}

// 3. Required public API symbols appear in the docs (reference pages).
const requiredSymbols = [
  "agentProcedure",
  "createCapabilityRegistry",
  "defaultToolName",
  "defineGovernance",
  "createAgentRuntime",
  "definePolicy",
  "composePolicies",
  "requireApproval",
  "unwrap",
  "createInMemoryApprovalCoordinator",
  "CapabilityError",
  "DescribeScope",
  "toJsonSchema",
  "registerSchemaConverter",
  "toAISDKTools",
  "createMCPServer",
  "createOpenTelemetryTracing",
  "createAgentTestRuntime",
  "fakeActor",
  "testClock",
  "approvalProbe",
  "capturedAudit",
  "createPgApprovalCoordinator",
  "createPgAuditSink",
];
for (const symbol of requiredSymbols) {
  if (!docs.includes(symbol)) failures.push(`public symbol ${symbol} not found in docs`);
}

// 4. Span names match between docs and implementation.
for (const span of [
  "agent.capability_call",
  "agent.policy_evaluation",
  "agent.approval_request",
  "agent.procedure_execution",
]) {
  if (!docs.includes(span)) failures.push(`span name ${span} missing from docs`);
  if (!coreSource.includes(`"${span}"`)) failures.push(`span name ${span} missing from core`);
}

// 5. The exposure surfaces are the same set everywhere.
for (const surface of ["direct", "aiSdk", "mcp", "workflow", "test"]) {
  if (!coreSource.includes(`"${surface}"`)) failures.push(`surface ${surface} missing from core`);
}

// 6. Denied reasons recorded in audit match the documented set.
for (const reason of ["unknown", "not-exposed", "hidden", "policy-denied", "policy-failed"]) {
  if (!eventsDoc.includes(`"${reason}"`)) {
    failures.push(`denied reason ${reason} missing from events doc`);
  }
  if (!coreSource.includes(`"${reason}"`)) {
    failures.push(`denied reason ${reason} missing from core`);
  }
}

// 7. No version string inside a status blockquote. Package versions live in the
//    README and on the home page; a per-page copy drifts on the first release
//    that forgets one.
const docPaths = [...walk("docs", ".md")];
for (const path of docPaths) {
  const first = read(path)
    .split("\n")
    .find((line) => line.startsWith(">"));
  if (!first) continue;
  const match = first.match(/(?:^|[\s—·(])v?\d+\.\d+(?:\.\d+)?(?=[\s.,—·)]|$)/);
  if (match && !/^docs\/(roadmap|migration\/|index)/.test(path)) {
    failures.push(`${path}: version string "${match[0].trim()}" in the status blockquote`);
  }
}

// 8. Cross-reference shorthands stay inside the range the owning page defines,
//    so a citation cannot outlive (or outrun) what it points at.
const maxOf = (text, pattern) =>
  Math.max(0, ...[...text.matchAll(pattern)].map((m) => Number(m[1])));

const ranges = [
  { label: "SI", max: maxOf(read("docs/security/security-model.md"), /\*\*SI-(\d+)\b/g), cite: /\bSI-(\d+)\b/g },
  { label: "ADR", max: maxOf(read("docs/architecture/decisions.md"), /^## ADR-(\d+):/gm), cite: /\bADR-(\d+)\b/g },
  { label: "T", max: maxOf(read("docs/security/threat-model.md"), /^\| T(\d+) \|/gm), cite: /\bT(\d+)\b(?![\w-])/g },
  { label: "Q", max: maxOf(read("docs/open-questions.md"), /^## Q(\d+) /gm), cite: /\bQ(\d+)\b/g },
  { label: "stage", max: 15, cite: /\bstages? (\d+)\b/gi },
];
for (const { label, max, cite } of ranges) {
  if (max === 0) {
    failures.push(`could not determine the highest ${label}-n — the owning page changed shape`);
    continue;
  }
  for (const path of docPaths) {
    for (const m of read(path).matchAll(cite)) {
      if (Number(m[1]) > max) failures.push(`${path}: cites ${m[0]}, but the highest is ${label}-${max}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Docs consistency check failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  "Docs consistency OK — symbols, error codes, events, spans, surfaces, banners, and cross-references align",
);
