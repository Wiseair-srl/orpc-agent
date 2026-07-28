import { os } from "@orpc/server";
import { z } from "zod";
import { createCapabilityRegistry } from "@orpc-agent/core";

/** A stand-in application entry: a registry exported at module scope. */
const refund = os
  .meta({
    agent: {
      description: "Refund an order.",
      expose: { aiSdk: true, mcp: true },
      sideEffect: "write",
      risk: "high",
      approval: { required: true },
    },
  })
  .input(z.object({ orderId: z.string() }))
  .handler(() => ({ ok: true }));

const list = os
  .meta({
    agent: {
      description: "List orders.",
      expose: { aiSdk: true },
      sideEffect: "read",
      risk: "low",
    },
  })
  .handler(() => []);

const internal = os.handler(() => "not a capability");

export const capabilities = createCapabilityRegistry({
  orders: { refund, list },
  internal,
});
