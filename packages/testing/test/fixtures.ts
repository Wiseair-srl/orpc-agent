import { os } from "@orpc/server";
import * as z from "zod";
import {
  agentProcedure,
  allow,
  createCapabilityRegistry,
  definePolicy,
  deny,
  requireApproval,
  type AgentInvocationInfo,
} from "@orpc-agent/core";

export type AppContext = {
  organizationId?: string;
  agent?: AgentInvocationInfo;
};

const base = agentProcedure(os.$context<AppContext>());

export const refundLimit = definePolicy("refund-limit", ({ capability, input }) => {
  if (capability.id !== "orders.refund") return allow();
  const { amount } = input as { amount: number };
  if (amount >= 5000) return deny("REFUND_TOO_LARGE", "Refunds of $5000 or more cannot be issued by agents.");
  if (amount > 500) return requireApproval({ reason: `Refund of $${amount} exceeds $500`, approvalType: "manager" });
  return allow();
});

export const orgIsolation = definePolicy("org-isolation", ({ actor, context }) =>
  actor.attributes?.orgId === (context as AppContext).organizationId
    ? allow()
    : deny("ORG_MISMATCH", "Operation not available for this organization."));

const FULL_CUSTOMER = {
  id: "c_1",
  name: "Alice",
  email: "alice@example.com",
  paymentMethods: [{ last4: "4242" }],
};

export const searchOrders = base
  .meta({
    agent: {
      description: "Search orders.",
      expose: { aiSdk: true, mcp: true, direct: true, test: true },
      sideEffect: "read",
      risk: "low",
    },
  })
  .input(z.object({ query: z.string().min(1) }))
  .handler(async () => ({ orders: [{ id: "ord_42" }] }));

export const getCustomer = base
  .meta({
    agent: {
      description: "Get a customer.",
      expose: { aiSdk: true, mcp: true, direct: true, test: true },
      sideEffect: "read",
      risk: "high",
      redact: {
        output: (o) => {
          const customer = o as typeof FULL_CUSTOMER;
          return {
            id: customer.id,
            name: customer.name,
            email: customer.email.replace(/^[^@]+/, "***"),
          };
        },
      },
    },
  })
  .input(z.object({ id: z.string() }))
  .handler(async () => FULL_CUSTOMER);

export const refundOrder = base
  .meta({
    agent: {
      description: "Refund an order.",
      expose: { aiSdk: true, direct: true, test: true },
      sideEffect: "write",
      risk: "high",
      policies: [refundLimit],
    },
  })
  .input(
    z.object({ orderId: z.string(), amount: z.number().positive(), reason: z.string().min(3) }),
  )
  .handler(async ({ input }) => ({ refundId: "ref_real", amount: input.amount, status: "issued" }));

export const capabilities = createCapabilityRegistry({
  orders: { search: searchOrders, refund: refundOrder },
  customers: { get: getCustomer },
});

export const REFUND_INPUT = { orderId: "ord_42", amount: 100, reason: "damaged" };
