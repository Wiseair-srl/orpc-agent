import type { Actor, AgentInvocationInfo } from "@orpc-agent/core";

/**
 * The application's world: sessions, seed data, and services. Everything is
 * in-memory and deterministic so the whole example runs in CI without
 * external systems.
 */

export type Session = {
  userId: string;
  name: string;
  orgId: string;
  permissions: string[];
};

export const SESSIONS = {
  dana: {
    userId: "u_dana",
    name: "Dana",
    orgId: "org_1",
    permissions: ["support:read", "orders:refund", "messages:send", "cases:write"],
  },
  priya: {
    userId: "u_priya",
    name: "Priya",
    orgId: "org_1",
    permissions: ["support:read", "approvals:decide"],
  },
  mallory: {
    userId: "u_mallory",
    name: "Mallory",
    orgId: "org_2",
    permissions: ["support:read", "orders:refund"],
  },
} satisfies Record<string, Session>;

export function actorFrom(session: Session): Actor {
  return {
    id: session.userId,
    kind: "user",
    displayName: session.name,
    attributes: { orgId: session.orgId, permissions: session.permissions },
  };
}

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

export type Customer = {
  id: string;
  orgId: string;
  name: string;
  email: string;
  paymentMethods: { brand: string; last4: string }[];
};

export type Order = {
  id: string;
  orgId: string;
  customerId: string;
  total: number;
  status: "delivered" | "shipped" | "refunded";
  refundable: boolean;
};

export type Db = ReturnType<typeof seedDb>;

export function seedDb() {
  const customers: Customer[] = [
    {
      id: "c_alice",
      orgId: "org_1",
      name: "Alice Doe",
      email: "alice@example.com",
      paymentMethods: [{ brand: "visa", last4: "4242" }],
    },
  ];
  const orders: Order[] = [
    { id: "ord_42", orgId: "org_1", customerId: "c_alice", total: 649, status: "delivered", refundable: true },
    { id: "ord_43", orgId: "org_1", customerId: "c_alice", total: 12000, status: "delivered", refundable: true },
  ];
  const refunds: { refundId: string; orderId: string; amount: number; idempotencyKey?: string }[] = [];
  const drafts: { id: string; caseId: string; text: string }[] = [];
  const sentMessages: { messageId: string; draftId: string; sentAt: Date }[] = [];
  const escalations: { caseId: string; priority: string }[] = [];
  const threads: Record<string, { from: "customer" | "support"; text: string }[]> = {
    case_7: [{ from: "customer", text: "My order arrived damaged. Please refund it." }],
  };
  const auditRows: unknown[] = [];
  return { customers, orders, refunds, drafts, sentMessages, escalations, threads, auditRows };
}

// ---------------------------------------------------------------------------
// Services (what handlers call). The payment gateway can be told to hang so
// tests can exercise timeouts against a signal-honoring downstream.
// ---------------------------------------------------------------------------

export function makeServices(db: Db) {
  const paymentGateway = { hang: false, calls: 0 };
  return {
    paymentGateway,
    customers: {
      async search(query: string, orgId: string) {
        return db.customers
          .filter((c) => c.orgId === orgId)
          .filter((c) => c.email.includes(query) || c.name.toLowerCase().includes(query.toLowerCase()))
          .map((c) => ({ id: c.id, name: c.name, email: c.email }));
      },
      async byId(id: string) {
        return db.customers.find((c) => c.id === id) ?? null;
      },
    },
    orders: {
      async list(customerId: string, orgId: string) {
        return db.orders
          .filter((o) => o.orgId === orgId && o.customerId === customerId)
          .map((o) => ({ id: o.id, total: o.total, status: o.status }));
      },
      async byId(id: string) {
        return db.orders.find((o) => o.id === id) ?? null;
      },
      async checkEligibility(orderId: string) {
        const order = db.orders.find((o) => o.id === orderId);
        if (!order) return { eligible: false, maxAmount: 0 };
        return { eligible: order.refundable && order.status !== "refunded", maxAmount: order.total };
      },
    },
    payments: {
      async refund(
        input: { orderId: string; amount: number; reason: string },
        options: { idempotencyKey: string; signal?: AbortSignal },
      ) {
        paymentGateway.calls += 1;
        if (paymentGateway.hang) {
          // A hung gateway: resolves only by abort (the handler forwards signal).
          await new Promise((_, reject) => {
            options.signal?.addEventListener("abort", () => reject(options.signal!.reason), {
              once: true,
            });
          });
        }
        const existing = db.refunds.find((r) => r.idempotencyKey === options.idempotencyKey);
        if (existing) return { refundId: existing.refundId, amount: existing.amount, status: "issued" as const };
        const refund = {
          refundId: `ref_${db.refunds.length + 77}`,
          orderId: input.orderId,
          amount: input.amount,
          idempotencyKey: options.idempotencyKey,
        };
        db.refunds.push(refund);
        const order = db.orders.find((o) => o.id === input.orderId);
        if (order) order.status = "refunded";
        return { refundId: refund.refundId, amount: refund.amount, status: "issued" as const };
      },
    },
    cases: {
      async thread(caseId: string) {
        return db.threads[caseId] ?? [];
      },
      async escalate(caseId: string, priority: string) {
        db.escalations.push({ caseId, priority });
        return { caseId, priority, escalated: true };
      },
    },
    mailer: {
      async createDraft(caseId: string, text: string) {
        const draft = { id: `draft_${db.drafts.length + 1}`, caseId, text };
        db.drafts.push(draft);
        return draft;
      },
      async sendDraft(draftId: string, options: { signal?: AbortSignal; now: () => Date }) {
        const draft = db.drafts.find((d) => d.id === draftId);
        if (!draft) throw new Error(`draft ${draftId} not found`);
        const message = { messageId: `msg_${db.sentMessages.length + 1}`, draftId, sentAt: options.now() };
        db.sentMessages.push(message);
        return message;
      },
    },
  };
}

export type Services = ReturnType<typeof makeServices>;

export type AppContext = {
  db: Db;
  services: Services;
  session: Session;
  organizationId: string;
  now: () => Date;
  agent?: AgentInvocationInfo;
};

export function createAppContext(
  session: Session,
  shared: { db: Db; services: Services; now: () => Date },
): AppContext {
  return {
    db: shared.db,
    services: shared.services,
    session,
    organizationId: session.orgId,
    now: shared.now,
  };
}
