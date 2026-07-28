#!/usr/bin/env node
/**
 * Acceptance criterion 7: public exports of every package equal the
 * Required-public-APIs list (docs/implementation/brief.md). Checks runtime
 * (value) exports against built dist and type exports against the .d.ts.
 * Run after `pnpm build`.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url).pathname;
const failures = [];

const REQUIRED = {
  core: {
    entry: "packages/core/dist/index.js",
    dts: "packages/core/dist/index.d.ts",
    values: [
      "agentProcedure",
      "createCapabilityRegistry",
      "defaultToolName",
      "createAgentRuntime",
      "definePolicy",
      "composePolicies",
      "allow",
      "deny",
      "hide",
      "requireApproval",
      "unwrap",
      "createInMemoryApprovalCoordinator",
      "CapabilityError",
    ],
    types: [
      "AgentMeta",
      "AgentCapability",
      "CapabilityRegistry",
      "AgentRuntime",
      "Actor",
      "AgentInvocationInfo",
      "ExecutionRequest",
      "ExecutionResult",
      "ExecutionOptions",
      "CapabilityDescriptor",
      "AgentPolicy",
      "PolicyDecision",
      "PolicyPhase",
      "PolicyRequest",
      "ApprovalRequest",
      "ApprovalRecord",
      "ApprovalDecision",
      "ApprovalCoordinator",
      "AgentAuditEvent",
      "AuditSink",
      "TracingAdapter",
      "SpanHandle",
      "ExposureSurface",
      "SideEffect",
      "RiskLevel",
      "FailureStage",
      "ErrorCode",
    ],
  },
  "core/schema": {
    entry: "packages/core/dist/schema/index.js",
    dts: "packages/core/dist/schema/index.d.ts",
    values: ["toJsonSchema", "registerSchemaConverter"],
    types: [],
  },
  "ai-sdk": {
    entry: "packages/ai-sdk/dist/index.js",
    dts: "packages/ai-sdk/dist/index.d.ts",
    values: ["toAISDKTools"],
    types: ["AISDKToolsOptions", "AISDKToolResult"],
  },
  mcp: {
    entry: "packages/mcp/dist/index.js",
    dts: "packages/mcp/dist/index.d.ts",
    values: ["createMCPServer"],
    types: ["MCPServerOptions"],
  },
  opentelemetry: {
    entry: "packages/opentelemetry/dist/index.js",
    dts: "packages/opentelemetry/dist/index.d.ts",
    values: ["createOpenTelemetryTracing"],
    types: [],
  },
  testing: {
    entry: "packages/testing/dist/index.js",
    dts: "packages/testing/dist/index.d.ts",
    values: ["createAgentTestRuntime", "fakeActor", "testClock", "approvalProbe", "capturedAudit"],
    types: [],
  },
  cli: {
    entry: "packages/cli/dist/index.js",
    dts: "packages/cli/dist/index.d.ts",
    values: [
      "buildSnapshot",
      "diffSnapshots",
      "loadSnapshot",
      "snapshotJson",
      "renderInventory",
      "renderChanges",
      "renderGithub",
      "renderMarkdown",
      "LoadError",
    ],
    types: ["CapabilitySnapshot", "CapabilityEntry", "Change", "ChangeKind", "LoadOptions"],
  },
  postgres: {
    entry: "packages/postgres/dist/index.js",
    dts: "packages/postgres/dist/index.d.ts",
    values: ["createPgApprovalCoordinator", "createPgAuditSink", "APPROVALS_DDL", "AUDIT_DDL"],
    types: ["PgQuery", "PgApprovalCoordinatorOptions", "PgAuditSinkOptions", "PgAuditSink"],
  },
};

for (const [name, spec] of Object.entries(REQUIRED)) {
  let moduleExports;
  try {
    moduleExports = await import(pathToFileURL(root + spec.entry).href);
  } catch (error) {
    failures.push(`${name}: cannot import ${spec.entry} — did you run pnpm build? (${error.message})`);
    continue;
  }
  const valueExports = Object.keys(moduleExports).filter((key) => key !== "default");
  for (const required of spec.values) {
    if (!valueExports.includes(required)) {
      failures.push(`${name}: missing required export "${required}"`);
    }
  }
  const dts = readFileSync(root + spec.dts, "utf8");
  for (const requiredType of spec.types) {
    const pattern = new RegExp(
      `(type|interface|class|declare class)\\s+${requiredType}\\b|\\b${requiredType}\\b[^;]*\\}(;|)\\s*$|\\b${requiredType}\\s+as\\b|\\b${requiredType}\\b,?\\s*(?=[,}])`,
      "m",
    );
    if (!pattern.test(dts)) {
      failures.push(`${name}: missing required type export "${requiredType}"`);
    }
  }
}

if (failures.length > 0) {
  console.error("API surface check failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("API surface OK — all required public exports present");
