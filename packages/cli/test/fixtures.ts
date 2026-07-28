import { os } from "@orpc/server";
import { z } from "zod";
import { createCapabilityRegistry, definePolicy, allow, type AgentMeta } from "@orpc-agent/core";
import type { CapabilityEntry, CapabilitySnapshot } from "../src/types";

const base: AgentMeta = {
  description: "does a thing",
  expose: { aiSdk: true },
  sideEffect: "read",
  risk: "low",
};

export const alwaysAllow = definePolicy("always-allow", () => allow());

export function procedure(meta: Partial<AgentMeta> | undefined, input?: z.ZodType) {
  const builder = meta === undefined ? os : os.meta({ agent: { ...base, ...meta } });
  const withInput = input ? builder.input(input) : builder;
  return withInput.handler(() => ({ ok: true }));
}

export function registryOf(defs: Parameters<typeof createCapabilityRegistry>[0]) {
  return createCapabilityRegistry(defs);
}

/** A minimal well-formed snapshot entry to mutate in diff tests. */
export function entry(overrides: Partial<CapabilityEntry> = {}): CapabilityEntry {
  return {
    id: "orders.refund",
    description: "refunds an order",
    sideEffect: "write",
    risk: "high",
    expose: ["aiSdk"],
    idempotent: false,
    tags: [],
    policies: [],
    inputSchemaHash: null,
    ...overrides,
  };
}

export function snapshot(entries: CapabilityEntry[], rest: Partial<CapabilitySnapshot> = {}): CapabilitySnapshot {
  return { version: 1, capabilities: entries, excluded: [], unexposed: [], ...rest };
}
