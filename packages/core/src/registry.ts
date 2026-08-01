import { isLazy, isProcedure, type AnyProcedure } from "@orpc/server";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ExposureSurface, RiskLevel, SideEffect } from "./types";
import type { AgentMeta } from "./meta";
import { normalizeAgentMeta, validateAgentMeta } from "./meta-validate";
import { toJsonSchema } from "./schema/index";

export type CapabilityDefs = { [segment: string]: AnyProcedure | CapabilityDefs };

export interface AgentCapability {
  /** Dot-joined path, e.g. "orders.refund". */
  id: string;
  path: string[];
  /** Normalized (defaults resolved). */
  meta: AgentMeta;
  inputSchema: StandardSchemaV1 | undefined;
  outputSchema: StandardSchemaV1 | undefined;
  procedure: AnyProcedure;
}

export type CapabilityQuery = {
  /** expose[surface] === true */
  surface?: ExposureSurface;
  /** any-of */
  tags?: string[];
  /** any-of */
  sideEffect?: SideEffect[];
  /** any-of */
  risk?: RiskLevel[];
};

export interface CapabilityRegistry {
  ids(): string[];
  get(id: string): AgentCapability | undefined;
  capabilities(): AgentCapability[];
  filter(query: CapabilityQuery | ((c: AgentCapability) => boolean)): CapabilityRegistry;
  inspect(): {
    capabilities: AgentCapability[];
    excluded: { path: string; reason: "no-agent-meta" }[];
    /** Capability ids whose expose map enables no surface at all. */
    unexposed: string[];
  };
}

/** Surfaces whose adapters need JSON Schema on the wire. */
const SCHEMA_CONSUMING_SURFACES: readonly ExposureSurface[] = ["aiSdk", "mcp"];

/**
 * Derives capabilities from a nested record of procedures. Only procedures
 * carrying `meta.agent` are included (SI-1); the rest are excluded and
 * reported via `inspect()`. Throws one aggregate error listing every problem.
 */
export function createCapabilityRegistry<T extends CapabilityDefs>(defs: T): CapabilityRegistry {
  if (typeof defs !== "object" || defs === null) {
    throw new TypeError("createCapabilityRegistry: defs must be an object of procedures");
  }

  const capabilities: AgentCapability[] = [];
  const excluded: { path: string; reason: "no-agent-meta" }[] = [];
  const problems: string[] = [];

  walk(defs, [], capabilities, excluded, problems);
  validateCrossCapability(capabilities, problems);

  if (problems.length > 0) {
    throw new Error(
      `Capability registry validation failed (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n` +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
  }

  return makeRegistry(capabilities, excluded);
}

function walk(
  node: CapabilityDefs,
  path: string[],
  capabilities: AgentCapability[],
  excluded: { path: string; reason: "no-agent-meta" }[],
  problems: string[],
): void {
  for (const [segment, value] of Object.entries(node)) {
    const currentPath = [...path, segment];
    const id = currentPath.join(".");

    if (segment.length === 0 || segment.includes(".")) {
      problems.push(`"${id}": path segments must be non-empty and must not contain "."`);
      continue;
    }

    if (isLazy(value)) {
      problems.push(
        `"${id}": lazy routers/procedures are not supported by the registry — ` +
          "resolve them (unlazyRouter) before registering",
      );
      continue;
    }

    if (isProcedure(value)) {
      const def = (value as AnyProcedure)["~orpc"];
      const agentMeta = (def.meta as { agent?: unknown } | undefined)?.agent;
      if (agentMeta === undefined) {
        excluded.push({ path: id, reason: "no-agent-meta" });
        continue;
      }

      const metaProblems = validateAgentMeta(agentMeta);
      for (const p of metaProblems) problems.push(`"${id}": ${p}`);

      if (isEventIteratorSchema(def.outputSchema) || isEventIteratorSchema(def.inputSchema)) {
        problems.push(
          `"${id}": event-iterator (streaming) procedures cannot be capabilities — ` +
            "capabilities must return complete values",
        );
        continue;
      }

      if (metaProblems.length === 0) {
        capabilities.push({
          id,
          path: currentPath,
          meta: normalizeAgentMeta(agentMeta as AgentMeta),
          inputSchema: def.inputSchema as StandardSchemaV1 | undefined,
          outputSchema: def.outputSchema as StandardSchemaV1 | undefined,
          procedure: value as AnyProcedure,
        });
      }
      continue;
    }

    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      if ("~orpc" in value) {
        problems.push(
          `"${id}": value looks like an oRPC object but is not an implemented procedure ` +
            "(contract-only procedures cannot be capabilities)",
        );
        continue;
      }
      walk(value as CapabilityDefs, currentPath, capabilities, excluded, problems);
      continue;
    }

    problems.push(`"${id}": value is not an oRPC procedure or a nested record of procedures`);
  }
}

function validateCrossCapability(capabilities: AgentCapability[], problems: string[]): void {
  for (const adapterKey of ["aiSdk", "mcp"] as const) {
    const seen = new Map<string, string>();
    for (const capability of capabilities) {
      if (capability.meta.expose[adapterKey] !== true) continue;
      const toolName =
        capability.meta.adapters?.[adapterKey]?.toolName ?? defaultToolName(capability.id);
      const existing = seen.get(toolName);
      if (existing) {
        problems.push(
          `tool name collision on surface "${adapterKey}": "${existing}" and "${capability.id}" ` +
            `both map to "${toolName}"`,
        );
      } else {
        seen.set(toolName, capability.id);
      }
    }
  }

  // Schema convertibility is a startup failure for schema-consuming surfaces,
  // never a first-call failure.
  for (const capability of capabilities) {
    const exposedToSchemaSurface = SCHEMA_CONSUMING_SURFACES.some(
      (surface) => capability.meta.expose[surface] === true,
    );
    if (!exposedToSchemaSurface || capability.inputSchema === undefined) continue;
    try {
      toJsonSchema(capability.inputSchema);
    } catch (error) {
      problems.push(
        `"${capability.id}": input schema cannot be converted to JSON Schema for its exposed ` +
          `surfaces (${(error as Error).message})`,
      );
    }
  }
}

/** Default protocol tool name: "." → "_". */
export function defaultToolName(capabilityId: string): string {
  return capabilityId.replace(/\./g, "_");
}

function isEventIteratorSchema(schema: unknown): boolean {
  if (typeof schema !== "object" || schema === null) return false;
  const standard = (schema as Record<string, unknown>)["~standard"];
  if (typeof standard !== "object" || standard === null) return false;
  // Pinned to @orpc/contract's marker symbol description (see ADR-001 addendum).
  return Object.getOwnPropertySymbols(standard).some(
    (symbol) => symbol.description === "ORPC_EVENT_ITERATOR_DETAILS",
  );
}

function makeRegistry(
  capabilities: AgentCapability[],
  excluded: { path: string; reason: "no-agent-meta" }[],
): CapabilityRegistry {
  const byId = new Map(capabilities.map((c) => [c.id, c]));

  return {
    ids() {
      return capabilities.map((c) => c.id);
    },
    get(id) {
      return byId.get(id);
    },
    capabilities() {
      return [...capabilities];
    },
    filter(query) {
      const predicate = typeof query === "function" ? query : queryPredicate(query);
      return makeRegistry(capabilities.filter(predicate), excluded);
    },
    inspect() {
      return {
        capabilities: [...capabilities],
        excluded: [...excluded],
        unexposed: capabilities
          .filter((c) => !Object.values(c.meta.expose).some((v) => v === true))
          .map((c) => c.id),
      };
    },
  };
}

function queryPredicate(query: CapabilityQuery): (c: AgentCapability) => boolean {
  return (c) => {
    if (query.surface !== undefined && c.meta.expose[query.surface] !== true) return false;
    if (query.tags !== undefined && !query.tags.some((t) => (c.meta.tags ?? []).includes(t))) {
      return false;
    }
    if (query.sideEffect !== undefined && !query.sideEffect.includes(c.meta.sideEffect)) {
      return false;
    }
    if (query.risk !== undefined && !query.risk.includes(c.meta.risk)) return false;
    return true;
  };
}
