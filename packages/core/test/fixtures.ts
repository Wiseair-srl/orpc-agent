import { os } from "@orpc/server";
import * as z from "zod";
import { agentProcedure } from "../src/procedure";
import type { AgentMeta } from "../src/meta";

export type AppContext = {
  organizationId?: string;
  services?: Record<string, unknown>;
};

export const base = os.$context<AppContext>();
export const agentBase = agentProcedure(base);

export function readMeta(overrides: Partial<AgentMeta> = {}): AgentMeta {
  return {
    description: "Test read capability.",
    expose: { direct: true, test: true },
    sideEffect: "read",
    risk: "low",
    ...overrides,
  };
}

export const searchOrders = agentBase
  .meta({ agent: readMeta({ description: "Search orders.", tags: ["orders"] }) })
  .input(z.object({ query: z.string().min(2), limit: z.number().int().max(50).default(10) }))
  .output(z.object({ orders: z.array(z.object({ id: z.string() })) }))
  .handler(async ({ input }) => ({
    orders: [{ id: `found:${input.query}:${input.limit}` }],
  }));

export const refundOrder = agentBase
  .meta({
    agent: {
      description: "Refund an order.",
      expose: { direct: true, aiSdk: true, test: true },
      sideEffect: "write",
      risk: "high",
      tags: ["orders", "money"],
    },
  })
  .input(z.object({ orderId: z.string(), amount: z.number().positive() }))
  .output(z.object({ refundId: z.string(), amount: z.number() }))
  .handler(async ({ input }) => ({ refundId: "ref_1", amount: input.amount }));

export const internalRecompute = base
  .input(z.object({}))
  .handler(async () => ({ ok: true }));
