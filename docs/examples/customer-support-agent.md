# Example: customer-support agent

> **Status:** Implemented — the flagship reference application, runnable under `examples/customer-support/` in the repository. Its test suite is the executable version of this document; `pnpm --filter customer-support-example demo` prints the end-to-end flow below.

One application, three clients of the same nine capabilities: a support dashboard (UI), an AI assistant in that dashboard (AI SDK), and an MCP endpoint for read-only external tooling. It exercises every v0.1 feature: authenticated context, org isolation, reads and writes, visibility, execution-time authorization, approval, audit, tracing, structured errors, cancellation, and deterministic tests.

## Architecture

```text
                       ┌─ Support dashboard UI ──── oRPC client ─┐
support agent (Dana) ──┤                                         │
                       └─ AI assistant (chat) ── AI SDK tools ───┤
                                                                 ▼
external tools ──── MCP client ── @orpc-agent/mcp ──►  agent runtime (@orpc-agent/core)
                                                       policies · approvals · audit · otel
                                                                 │  oRPC call (middleware runs here)
                                                                 ▼
                                              procedures ── services ── Postgres / payment gw / email
manager (Priya) ──── approvals dashboard ── runtime.approvals + runtime.resume
```

The UI calls procedures through its normal oRPC router **and** the assistant reaches the *same* procedures through the runtime — one implementation, two paths, identical middleware. (The UI could also route through `surface: "direct"` for a unified audit trail — shown as a variant in the example code.)

## Capability inventory

| Capability | sideEffect / risk | expose | Governance |
|---|---|---|---|
| `customers.search` | read / medium | aiSdk, mcp, direct | Support staff only (middleware `support:read`) |
| `customers.get` | read / **high** (PII) | aiSdk, mcp, direct | Output redaction: mask email, drop payment methods |
| `orders.list` | read / low | aiSdk, mcp, direct | — |
| `orders.get` | read / medium | aiSdk, mcp, direct | — |
| `orders.checkRefundEligibility` | read / low | aiSdk, mcp, direct | — |
| `orders.refund` | **write / high** | aiSdk, direct (— **not mcp**) | Middleware `orders:refund`; policy: > $500 ⇒ manager approval; ≥ $5000 ⇒ deny |
| `messages.draft` | none / low | aiSdk, direct | No approval — creates a draft only |
| `messages.send` | **external / high** | aiSdk, direct | Static approval `human-confirmation` (inline) — a human clicks send, always |
| `cases.escalate` | write / medium | aiSdk, direct | Audited like all writes; no approval |

**Not present at all:** `accounts.delete` — account deletion is not modeled as a capability; the strongest exposure decision is nonexistence.

## Definitions (representative)

```ts
// src/capabilities/orders.ts
export const refundOrder = agentBase
  .use(requirePermission("orders:refund"))
  .use(requireSameOrg((input: { orderId: string }) => input.orderId))
  .meta({
    agent: {
      description: "Refund an order, fully or partially. Check orders.checkRefundEligibility first.",
      expose: { aiSdk: true, direct: true, test: true },
      sideEffect: "write",
      risk: "high",
      tags: ["orders", "money"],
      redact: {
        output: (o) => ({ ...(o as Refund), gatewayRef: undefined }),
        approvalInput: (i) => i as object,          // small input; show it all to approvers
      },
      policies: [refundLimit],
    },
  })
  .errors({ NOT_ELIGIBLE: { message: "Order is not eligible for refund." } })
  .input(z.strictObject({ orderId: z.string(), amount: z.number().positive().max(100_000), reason: z.string().min(4).max(500) }))
  .output(RefundResult)
  .handler(async ({ input, context, errors, signal }) => {
    const elig = await context.orders.checkEligibility(input.orderId, { signal });
    if (!elig.eligible || input.amount > elig.maxAmount) throw errors.NOT_ELIGIBLE();
    return context.payments.refund(input, { idempotencyKey: context.agent!.idempotencyKey, signal });
  });
```

```ts
// src/capabilities/messages.ts — untrusted content labeled at the source
export const getCustomerThread = agentBase   // helper read used by drafts
  .meta({ agent: { description: "Load the customer's message thread.", expose: { aiSdk: true, direct: true, test: true }, sideEffect: "read", risk: "medium" } })
  .input(z.strictObject({ caseId: z.string() }))
  .output(z.object({ untrustedContent: z.array(z.object({ from: z.enum(["customer", "support"]), text: z.string() })) }))
  .handler(async ({ input, context }) => ({ untrustedContent: await context.cases.thread(input.caseId) }));
// The chat endpoint wraps untrustedContent in <customer> tags with a data-not-instructions notice.

export const sendMessage = agentBase
  .meta({ agent: {
    description: "Send a drafted message to the customer. Requires explicit confirmation.",
    expose: { aiSdk: true, direct: true, test: true },
    sideEffect: "external", risk: "high",
    approval: { required: true, type: "human-confirmation" },
  }})
  .input(z.strictObject({ draftId: z.string() }))
  .output(z.object({ messageId: z.string(), sentAt: z.date() }))
  .handler(async ({ input, context, signal }) => context.mailer.sendDraft(input.draftId, { signal }));
```

```ts
// src/policies.ts
export const refundLimit = definePolicy("refund-limit", ({ capability, input }) => {
  if (capability.id !== "orders.refund") return allow();
  const { amount } = input as { amount: number };
  if (amount >= 5000) return deny("REFUND_TOO_LARGE", "Refunds of $5000 or more cannot be issued by agents.");
  if (amount > 500)   return requireApproval({ reason: `Refund of $${amount} exceeds $500`, approvalType: "manager" });
  return allow();
});

export const orgIsolation = definePolicy("org-isolation", ({ actor, context }) =>
  actor.attributes?.orgId === (context as AppContext).organizationId
    ? allow() : deny("ORG_MISMATCH", "Operation not available for this organization."));

export const mcpReadOnly = definePolicy("mcp-read-only", ({ surface, capability }) =>
  surface === "mcp" && !["read", "none"].includes(capability.meta.sideEffect)
    ? deny("MCP_READ_ONLY", "Write operations are not available over MCP.") : allow());
```

`mcpReadOnly` is belt-and-suspenders — writes aren't *exposed* to mcp anyway (SI-1); the policy guards against a future exposure mistake (defense in depth, cheap).

## Wiring

```ts
// src/runtime.ts
export const capabilities = createCapabilityRegistry({
  customers: { search: searchCustomers, get: getCustomer },
  orders: { list: listOrders, get: getOrder, checkRefundEligibility, refund: refundOrder },
  messages: { draft: draftMessage, send: sendMessage, getCustomerThread },
  cases: { escalate: escalateCase },
});

// What an agent may reach, and what is evaluated first — declared once, and
// what `orpc-agent` reads. Every runtime below is built from this value.
export const governance = defineGovernance({
  registry: capabilities,
  policies: [orgIsolation, mcpReadOnly],
});

export const runtime = createAgentRuntime({
  governance,
  approvals: {
    coordinator: createDbApprovalCoordinator(db),           // in-memory in dev
    handler: undefined,                                     // messages.send uses inline confirm in the chat UI variant
  },
  audit: { sinks: [dbAuditSink], strict: false },
  tracing: createOpenTelemetryTracing(),
});
```

```ts
// src/api/chat.ts — the assistant endpoint
export async function POST(req: Request) {
  const session = await requireSession(req);
  const context = await createAppContext(session);
  const tools = await toAISDKTools(runtime, { actor: actorFrom(session), context });
  return streamText({ model, system: systemPrompt(session), messages: await req.json(), tools, stopWhen: stepCountIs(8) }).toUIMessageStreamResponse();
}

// src/api/mcp.ts — external, read-only in effect
export const mcp = createMCPServer(runtime, {
  serverInfo: { name: "acme-support", version: "0.1.0" },
  createContext: async (mcpSession) => {
    const principal = await verifyOAuth(mcpSession.authInfo);
    return { actor: { id: principal.sub, kind: "user", attributes: { orgId: principal.orgId } }, context: await createAppContextForUser(principal.sub) };
  },
});
```

## The end-to-end flow (normative for the example)

Dana: *"Customer alice@example.com says her order arrived damaged — refund it and let her know."*

```text
 1. model → customers_search {query:"alice@example.com"}     completed (read, low)
 2. model → orders_list {customerId:"c_alice"}               completed
 3. model → orders_checkRefundEligibility {orderId:"ord_42"} completed {eligible:true,maxAmount:649}
 4. model → orders_refund {orderId:"ord_42",amount:649,reason:"damaged item"}
      stage 7: refund-limit → require-approval (649 > 500)
      → { status:"approval-required", approvalId:"apr_9" }
      assistant: "Refund needs manager approval — request apr_9 pending."
 5. Priya (manager) approves apr_9 in the approvals dashboard   [capability.approved]
 6. dashboard worker → runtime.resume("apr_9", { context })
      integrity: hash ✓ · unconsumed ✓ · Priya ≠ Dana ✓ · consumed
      stage 11: middleware re-checks orders:refund + org  → handler refunds via gateway
      → completed { refundId:"ref_77", amount:649 }          [exe_02 linked to apr_9]
 7. app posts outcome into the chat; Dana: "tell her it's done"
 8. model → messages_draft {caseId, text…}                   completed (none/low, no approval)
 9. model → messages_send {draftId}
      static approval human-confirmation → inline handler → Dana clicks Send in the UI
      → completed { messageId }                              [external/high, human on the button]
10. audit trail: requested/approval_requested/approved/started/completed ×
    refund + draft + send · traces show agent.capability_call under the chat span
```

Failure branches (each covered by a test): a $9,000 amount → `POLICY_DENIED` at step 4; Priya rejects → `APPROVAL_REJECTED` at 6; 16 minutes idle → `APPROVAL_EXPIRED`; MCP client calls `orders_refund` → `CAPABILITY_NOT_FOUND` (concealed, SI-8); payment gateway hangs → `TIMEOUT`, not retried (write, SI-11).

## Tests shipped with the example

The example's suite is the executable version of this document — exposure snapshots per surface, the refund policy table (`400/649/9000`), the full approval lifecycle including self-approval and expiry, `customers.get` redaction, concealment over MCP, timeout with a signal-honoring stub, and the audit-sequence assertion for the flow above ([guides/testing-capabilities.md](../guides/testing-capabilities.md) shows every pattern).

## What this example does not show

Durable approval resumption across restarts with a workflow engine (Deferred, [ADR-007](../architecture/decisions.md#adr-007-durable-execution-is-adapter-based)); streaming outputs; rate limiting (app-level, [threat T5](../security/threat-model.md)); multi-agent orchestration (out of scope entirely).
