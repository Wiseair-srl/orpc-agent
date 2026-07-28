import { defaultToolName, type AgentCapability, type CapabilityRegistry } from "@orpc-agent/core";
import { toJsonSchema } from "@orpc-agent/core/schema";
import { canonicalJson, sha256 } from "./canonical";
import type { CapabilityEntry, CapabilitySnapshot } from "./types";

/** Surfaces that put a tool name and a JSON Schema on the wire. */
const SCHEMA_SURFACES = ["aiSdk", "mcp"] as const;

/** Fixed field order for every entry — see canonical.ts. */
export function buildSnapshot(
  registry: CapabilityRegistry,
  options: { descriptions?: boolean } = {},
): CapabilitySnapshot {
  const withDescriptions = options.descriptions !== false;
  const { capabilities, excluded, unexposed } = registry.inspect();

  return {
    version: 1,
    capabilities: [...capabilities]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((capability) => entryFor(capability, withDescriptions)),
    excluded: excluded.map((e) => e.path).sort(),
    unexposed: [...unexposed].sort(),
  };
}

function entryFor(capability: AgentCapability, withDescriptions: boolean): CapabilityEntry {
  const meta = capability.meta;

  // Only `true` exposes (SI-1), so an explicit `false` and an absent surface
  // are the same fact and must serialize identically.
  const expose = Object.entries(meta.expose)
    .filter(([, enabled]) => enabled === true)
    .map(([surface]) => surface)
    .sort() as CapabilityEntry["expose"];

  const toolNames: { [surface: string]: string } = {};
  for (const surface of SCHEMA_SURFACES) {
    if (meta.expose[surface] !== true) continue;
    toolNames[surface] = meta.adapters?.[surface]?.toolName ?? defaultToolName(capability.id);
  }

  const approvalRequired = meta.approval?.required === true;

  return {
    id: capability.id,
    ...(withDescriptions ? { description: meta.description } : {}),
    sideEffect: meta.sideEffect,
    risk: meta.risk,
    expose,
    ...(Object.keys(toolNames).length > 0 ? { toolNames } : {}),
    ...(meta.approval
      ? {
          approval: {
            required: approvalRequired,
            ...(meta.approval.type !== undefined ? { type: meta.approval.type } : {}),
            ...(meta.approval.expiresInMs !== undefined
              ? { expiresInMs: meta.approval.expiresInMs }
              : {}),
          },
        }
      : {}),
    idempotent: meta.idempotent === true,
    ...(meta.retry
      ? {
          retry: {
            maxAttempts: meta.retry.maxAttempts,
            ...(meta.retry.backoffMs !== undefined ? { backoffMs: meta.retry.backoffMs } : {}),
            retryOn: typeof meta.retry.retryOn === "function",
          },
        }
      : {}),
    ...(meta.timeoutMs !== undefined ? { timeoutMs: meta.timeoutMs } : {}),
    tags: [...(meta.tags ?? [])].sort(),
    policies: (meta.policies ?? []).map((policy) => policy.name),
    ...(meta.redact
      ? {
          redact: {
            output: typeof meta.redact.output === "function",
            approvalInput: typeof meta.redact.approvalInput === "function",
          },
        }
      : {}),
    inputSchemaHash: hashInputSchema(capability),
  };
}

function hashInputSchema(capability: AgentCapability): CapabilityEntry["inputSchemaHash"] {
  if (capability.inputSchema === undefined) return null;
  try {
    return sha256(canonicalJson(toJsonSchema(capability.inputSchema)));
  } catch {
    // A capability exposed only to non-schema surfaces may legitimately carry
    // a schema no converter handles. Recording the state beats aborting the
    // run: moving into or out of it is itself drift worth showing.
    return "unconvertible";
  }
}
