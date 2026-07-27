import { ORPCError, os } from "@orpc/server";
import * as z from "zod";
import { agentProcedure } from "@orpc-agent/core";
import type { AppContext } from "./context";
import { refundLimit } from "./policies";

/**
 * The nine capabilities (plus the getCustomerThread helper read) from
 * docs/examples/customer-support-agent.md. One implementation serves the
 * dashboard UI (plain oRPC), the AI assistant (aiSdk), and MCP.
 */

const base = os.$context<AppContext>();
export const agentBase = agentProcedure(base);

// --- Middleware: authoritative application authorization (ADR-008) ---------

const requirePermission = (permission: string) =>
  os.$context<AppContext>().middleware(async ({ context, next }) => {
    if (!context.session.permissions.includes(permission)) {
      throw new ORPCError("FORBIDDEN", { message: `Missing permission: ${permission}` });
    }
    return next();
  });

const requireSameOrgOrder = os.$context<AppContext>().middleware(async ({ context, next }, input) => {
  const { orderId } = input as { orderId: string };
  const order = await context.services.orders.byId(orderId);
  if (order && order.orgId !== context.organizationId) {
    throw new ORPCError("FORBIDDEN", { message: "Order belongs to another organization." });
  }
  return next();
});

// --- customers -------------------------------------------------------------

export const searchCustomers = agentBase
  .use(requirePermission("support:read"))
  .meta({
    agent: {
      description: "Search customers by name or email. Use before order lookups.",
      expose: { aiSdk: true, mcp: true, direct: true, test: true },
      sideEffect: "read",
      risk: "medium",
      tags: ["customers"],
    },
  })
  .input(z.strictObject({ query: z.string().min(2) }))
  .output(z.object({ customers: z.array(z.object({ id: z.string(), name: z.string(), email: z.string() })) }))
  .handler(async ({ input, context }) => ({
    customers: await context.services.customers.search(input.query, context.organizationId),
  }));

const CustomerOut = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  paymentMethods: z.array(z.object({ brand: z.string(), last4: z.string() })),
});

export const getCustomer = agentBase
  .use(requirePermission("support:read"))
  .meta({
    agent: {
      description: "Get a customer's profile by id.",
      expose: { aiSdk: true, mcp: true, direct: true, test: true },
      sideEffect: "read",
      risk: "high",
      tags: ["customers", "pii"],
      redact: {
        // Mask the email, drop payment methods before anything reaches a model.
        output: (o) => {
          const c = o as z.infer<typeof CustomerOut>;
          return { id: c.id, name: c.name, email: c.email.replace(/^[^@]{2,}/, "***") };
        },
      },
    },
  })
  .input(z.strictObject({ id: z.string() }))
  .output(CustomerOut)
  .handler(async ({ input, context, errors }) => {
    const customer = await context.services.customers.byId(input.id);
    if (!customer || customer.orgId !== context.organizationId) {
      throw new ORPCError("NOT_FOUND", { message: "Customer not found." });
    }
    return customer;
  });

// --- orders ----------------------------------------------------------------

export const listOrders = agentBase
  .meta({
    agent: {
      description: "List a customer's orders.",
      expose: { aiSdk: true, mcp: true, direct: true, test: true },
      sideEffect: "read",
      risk: "low",
      tags: ["orders"],
    },
  })
  .input(z.strictObject({ customerId: z.string() }))
  .output(z.object({ orders: z.array(z.object({ id: z.string(), total: z.number(), status: z.string() })) }))
  .handler(async ({ input, context }) => ({
    orders: await context.services.orders.list(input.customerId, context.organizationId),
  }));

export const getOrder = agentBase
  .meta({
    agent: {
      description: "Get one order by id.",
      expose: { aiSdk: true, mcp: true, direct: true, test: true },
      sideEffect: "read",
      risk: "medium",
      tags: ["orders"],
    },
  })
  .input(z.strictObject({ orderId: z.string() }))
  .output(z.object({ id: z.string(), total: z.number(), status: z.string() }))
  .handler(async ({ input, context }) => {
    const order = await context.services.orders.byId(input.orderId);
    if (!order || order.orgId !== context.organizationId) {
      throw new ORPCError("NOT_FOUND", { message: "Order not found." });
    }
    return { id: order.id, total: order.total, status: order.status };
  });

export const checkRefundEligibility = agentBase
  .meta({
    agent: {
      description: "Check whether an order can be refunded and up to what amount.",
      expose: { aiSdk: true, mcp: true, direct: true, test: true },
      sideEffect: "read",
      risk: "low",
      tags: ["orders", "money"],
    },
  })
  .input(z.strictObject({ orderId: z.string() }))
  .output(z.object({ eligible: z.boolean(), maxAmount: z.number() }))
  .handler(async ({ input, context }) => context.services.orders.checkEligibility(input.orderId));

export const refundOrder = agentBase
  .use(requirePermission("orders:refund"))
  .use(requireSameOrgOrder)
  .meta({
    agent: {
      description: "Refund an order, fully or partially. Check orders.checkRefundEligibility first.",
      // Deliberately NOT exposed to mcp — external tools read, never move money.
      expose: { aiSdk: true, direct: true, test: true },
      sideEffect: "write",
      risk: "high",
      tags: ["orders", "money"],
      redact: {
        output: (o) => ({ ...(o as object), gatewayRef: undefined }),
        approvalInput: (i) => i as object, // small input; show it all to approvers
      },
      policies: [refundLimit],
    },
  })
  .errors({ NOT_ELIGIBLE: { message: "Order is not eligible for refund." } })
  .input(
    z.strictObject({
      orderId: z.string(),
      amount: z.number().positive().max(100_000),
      reason: z.string().min(4).max(500),
    }),
  )
  .output(z.object({ refundId: z.string(), amount: z.number(), status: z.string() }))
  .handler(async ({ input, context, errors, signal }) => {
    const elig = await context.services.orders.checkEligibility(input.orderId);
    if (!elig.eligible || input.amount > elig.maxAmount) throw errors.NOT_ELIGIBLE();
    return context.services.payments.refund(input, {
      idempotencyKey: context.agent!.idempotencyKey,
      ...(signal ? { signal } : {}),
    });
  });

// --- messages --------------------------------------------------------------

export const getCustomerThread = agentBase
  .meta({
    agent: {
      description: "Load the customer's message thread.",
      expose: { aiSdk: true, direct: true, test: true },
      sideEffect: "read",
      risk: "medium",
      tags: ["messages"],
    },
  })
  .input(z.strictObject({ caseId: z.string() }))
  .output(
    z.object({
      untrustedContent: z.array(z.object({ from: z.enum(["customer", "support"]), text: z.string() })),
    }),
  )
  .handler(async ({ input, context }) => ({
    untrustedContent: await context.services.cases.thread(input.caseId),
  }));

export const draftMessage = agentBase
  .meta({
    agent: {
      description: "Create a message draft for a case. Does not send anything.",
      expose: { aiSdk: true, direct: true, test: true },
      sideEffect: "none",
      risk: "low",
      tags: ["messages"],
    },
  })
  .input(z.strictObject({ caseId: z.string(), text: z.string().min(1).max(2000) }))
  .output(z.object({ id: z.string(), caseId: z.string(), text: z.string() }))
  .handler(async ({ input, context }) => context.services.mailer.createDraft(input.caseId, input.text));

export const sendMessage = agentBase
  .use(requirePermission("messages:send"))
  .meta({
    agent: {
      description: "Send a drafted message to the customer. Requires explicit confirmation.",
      expose: { aiSdk: true, direct: true, test: true },
      sideEffect: "external",
      risk: "high",
      tags: ["messages"],
      approval: { required: true, type: "human-confirmation" },
    },
  })
  .input(z.strictObject({ draftId: z.string() }))
  .output(z.object({ messageId: z.string(), sentAt: z.date() }))
  .handler(async ({ input, context, signal }) =>
    context.services.mailer.sendDraft(input.draftId, {
      now: context.now,
      ...(signal ? { signal } : {}),
    }),
  );

// --- cases -----------------------------------------------------------------

export const escalateCase = agentBase
  .use(requirePermission("cases:write"))
  .meta({
    agent: {
      description: "Escalate a case to a human specialist queue.",
      expose: { aiSdk: true, direct: true, test: true },
      sideEffect: "write",
      risk: "medium",
      tags: ["cases"],
    },
  })
  .input(z.strictObject({ caseId: z.string(), priority: z.enum(["normal", "high", "urgent"]) }))
  .output(z.object({ caseId: z.string(), priority: z.string(), escalated: z.boolean() }))
  .handler(async ({ input, context }) => context.services.cases.escalate(input.caseId, input.priority));
