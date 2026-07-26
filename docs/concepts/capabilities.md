# Capabilities

> **Status:** Design draft — v0.1 concepts. APIs shown are **Proposed API**.

A **capability** is a governed application operation derived from an oRPC procedure. It is the central abstraction of oRPC Agent — not "tool", which is only how one adapter represents a capability on one surface ([ADR-002](../architecture/decisions.md#adr-002-capability-is-the-internal-abstraction)).

## Why not just call procedures?

A procedure answers "what does this operation do?". Handing it to an agent raises questions the procedure alone cannot answer:

- May this *surface* reach it at all? (a UI action is not automatically an MCP tool)
- What does it do to the world — read, write, destroy, leave the system?
- How sensitive is it, independent of side effects?
- May it be retried? Must a human approve it? What may models see of its output?
- Who asked, and where is that recorded?

A capability is a procedure plus those answers, made explicit and machine-readable.

## Anatomy

```text
capability "orders.refund"
├── identity            id (registry path), tags
├── contract            input schema, output schema      <- from the procedure
├── implementation      handler + oRPC middleware        <- from the procedure
├── description         model-facing usage text          \
├── exposure            per-surface allow map             \
├── classification      sideEffect + risk                  |  AgentMeta
├── execution policy    timeout, retry, idempotency        |  (.meta({ agent }))
├── approval policy     static gate or policy-driven      /
├── redaction           output / approvalInput hooks     /
└── adapter hints       tool names, MCP annotations     /
```

Everything above the line already exists in your oRPC codebase; oRPC Agent adds the metadata block and never forks the implementation ([ADR-001](../architecture/decisions.md#adr-001-orpc-procedures-are-the-source-of-truth)).

## Defining one

```ts
import { os } from "@orpc/server";
import { agentProcedure } from "@orpc-agent/core";
import * as z from "zod";

const base = os.$context<AppContext>().use(requireSession);
const agentBase = agentProcedure(base);

export const refundOrder = agentBase
  .meta({
    agent: {
      description: "Refund an order, fully or partially. Check eligibility first.",
      expose: { aiSdk: true, direct: true },        // not on mcp
      sideEffect: "write",
      risk: "high",
      tags: ["orders", "money"],
      redact: { output: (o) => ({ ...(o as Refund), gatewayRef: undefined }) },
    },
  })
  .errors({ NOT_ELIGIBLE: { message: "Order is not eligible for refund." } })
  .input(z.object({ orderId: z.string(), amount: z.number().positive(), reason: z.string() }))
  .output(RefundResult)
  .handler(async ({ input, context, errors, signal }) => {
    if (!(await context.orders.isRefundable(input.orderId))) throw errors.NOT_ELIGIBLE();
    return context.payments.refund(input, { signal });
  });
```

The procedure remains a plain oRPC procedure: mount it in your router, call it from your UI, generate OpenAPI from it. The `agent` block only matters to `createCapabilityRegistry` and the runtime.

## One capability, many surfaces

| Surface | Representation | Trust profile |
|---|---|---|
| `direct` | `runtime.invoke` from your server code | Your code, your process |
| `aiSdk` | AI SDK tool in your model loop | Your process, model-chosen arguments |
| `mcp` | MCP tool for external clients | External client, model-chosen arguments |
| `workflow` | Step in a durable workflow (future adapter) | Your infrastructure, replayed calls |
| `test` | Deterministic test invocation | CI |

Same validation, same policies, same middleware, same audit trail on every surface — that uniformity is the product. Exposure differs per surface because trust differs per surface ([ADR-004](../architecture/decisions.md#adr-004-exposure-is-explicit-and-surface-specific)).

## Granularity guidance

Good capabilities are **narrow verbs over governed nouns**:

- `orders.refund(orderId, amount, reason)` — good: bounded, classifiable, approvable.
- `db.query(sql)` — bad: unbounded power, unclassifiable side effects, unpoliceable (and a prompt-injection amplifier — see [security/prompt-injection.md](../security/prompt-injection.md)).
- `orders.manage(action, payload)` — bad: one capability with five side-effect profiles; split it.

If you cannot assign a single honest `sideEffect` value, the capability is too broad.

## Related

- [Registry](registry.md) — how capabilities get identity · [Runtime](runtime.md) — how they execute
- Reference: [metadata.md](../reference/metadata.md) · Guide: [defining-capabilities.md](../guides/defining-capabilities.md)
