import { describe, expect, test } from "vitest";
import { os } from "@orpc/server";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { createAgentRuntime } from "../src/runtime/create";
import { defineGovernance } from "../src/governance";
import { createCapabilityRegistry } from "../src/registry";
import { agentProcedure } from "../src/procedure";
import { registerSchemaConverter } from "../src/schema/index";
import type { AgentInvocationInfo } from "../src/types";

/**
 * Conversion memoization (v0.2, ADR-014): one conversion per schema object,
 * cache invalidated on converter re-registration, descriptors isolated from
 * the cache by cloning.
 */

const base = agentProcedure(os.$context<{ agent?: AgentInvocationInfo }>());

function schemaFor(vendor: string): StandardSchemaV1 {
  return {
    "~standard": {
      version: 1,
      vendor,
      validate: (value: unknown) => ({ value }),
    },
  };
}

function capabilityWith(schema: StandardSchemaV1) {
  return base
    .meta({
      agent: {
        description: "Echo.",
        expose: { aiSdk: true },
        sideEffect: "read",
        risk: "low",
      },
    })
    .input(schema)
    .handler(async () => ({ ok: true }));
}

const actor = { id: "u_dana", kind: "user" as const };

test("conversion runs once per schema across construction and repeated describe", async () => {
  let conversions = 0;
  registerSchemaConverter("memo-vendor", () => {
    conversions += 1;
    return { type: "object", properties: { text: { type: "string" } } };
  });

  const runtime = createAgentRuntime({ governance: defineGovernance({ registry: createCapabilityRegistry({ echo: capabilityWith(schemaFor("memo-vendor")) }) }) });
  // Startup verification already converted (and cached).
  expect(conversions).toBe(1);

  await runtime.describe("aiSdk", { actor, context: {} });
  await runtime.describe("aiSdk", { actor, context: {} });
  expect(conversions).toBe(1);
});

test("mutating a descriptor's inputSchema cannot poison later describes", async () => {
  registerSchemaConverter("isolation-vendor", () => ({
    type: "object",
    properties: { text: { type: "string" } },
  }));
  const runtime = createAgentRuntime({ governance: defineGovernance({ registry: createCapabilityRegistry({ echo: capabilityWith(schemaFor("isolation-vendor")) }) }) });

  const [first] = await runtime.describe("aiSdk", { actor, context: {} });
  (first!.inputSchema as Record<string, unknown>).poisoned = true;
  ((first!.inputSchema.properties as Record<string, unknown>).text as Record<string, unknown>).type =
    "number";

  const [second] = await runtime.describe("aiSdk", { actor, context: {} });
  expect(second!.inputSchema.poisoned).toBeUndefined();
  expect(second!.inputSchema.properties).toEqual({ text: { type: "string" } });
});

describe("converter re-registration", () => {
  test("invalidates cached conversions from the previous converter", async () => {
    registerSchemaConverter("swap-vendor", () => ({ type: "object", version: "v1" }));
    const runtime = createAgentRuntime({ governance: defineGovernance({ registry: createCapabilityRegistry({ echo: capabilityWith(schemaFor("swap-vendor")) }) }) });
    const [before] = await runtime.describe("aiSdk", { actor, context: {} });
    expect(before!.inputSchema.version).toBe("v1");

    registerSchemaConverter("swap-vendor", () => ({ type: "object", version: "v2" }));
    const [after] = await runtime.describe("aiSdk", { actor, context: {} });
    expect(after!.inputSchema.version).toBe("v2");
  });
});
