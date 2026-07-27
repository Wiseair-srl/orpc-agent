# Guide: defining capabilities

> **Status:** Implemented in v0.1. Assumes an existing oRPC app. Concepts: [capabilities](../concepts/capabilities.md); contract: [reference/metadata.md](../reference/metadata.md).

## 1. Create an agent-typed base once

```ts
// src/orpc.ts
import { os } from "@orpc/server";
import { agentProcedure } from "@orpc-agent/core";

export const base = os.$context<AppContext>().use(requireSession);
export const agentBase = agentProcedure(base);   // types meta.agent + ctx.agent; changes nothing else
```

Existing procedures built from `base` keep working; build agent-facing ones from `agentBase` (or rebase existing ones — it's the same builder, retyped).

## 2. Annotate a procedure

Start from an operation your app already performs, and answer the four required questions — description, exposure, side effect, risk:

```ts
export const checkRefundEligibility = agentBase
  .meta({
    agent: {
      description:
        "Check whether an order is eligible for refund and up to what amount. Use before orders.refund.",
      expose: { aiSdk: true, mcp: true, direct: true },
      sideEffect: "read",
      risk: "low",
      tags: ["orders", "refunds"],
    },
  })
  .input(z.object({ orderId: z.string() }))
  .output(z.object({ eligible: z.boolean(), maxAmount: z.number(), reason: z.string().optional() }))
  .handler(async ({ input, context, signal }) =>
    context.orders.checkEligibility(input.orderId, { signal }));
```

Write the description for the model: what it does, when to use it, what to call first. Keep security rules out of it — descriptions inform, policies enforce ([prompt-injection.md](../security/prompt-injection.md#what-you-must-still-do)).

## 3. Classify honestly

- `sideEffect` is about the *world*: does invoking this change state (`write`), destroy it (`destructive`), or leave your system (`external`)? When one procedure would need two answers, split it.
- `risk` is about *sensitivity*, independent of side effect: `customers.get` returning contact data is `read`/`medium`; a salary lookup would be `read`/`high`. If two reviewers would argue, pick the higher one.

These two fields drive retry eligibility, policy targeting, and approval routing later — misclassification is the quiet way to defeat the governance layer.

## 4. Schema discipline

The input schema is your first security control (pipeline stage 5):

- Constrain everything: `z.string().max(200)`, `z.number().positive().max(100_000)`, enums over free strings, `.strict()` objects so unexpected keys fail loudly.
- No pass-through blobs (`z.record(z.unknown())` in an input is a smell — that's un-policeable surface).
- Output schemas are contracts too (stage 12 enforces them) — return the minimum the caller needs; every extra field is model-visible unless redacted.

## 5. Handlers under governance

Three obligations, all ordinary oRPC:

```ts
.errors({ NOT_ELIGIBLE: { message: "Order is not eligible for refund." } })   // declared = model-visible
.handler(async ({ input, context, errors, signal }) => {
  if (context.agent) { /* optional: agent-specific behavior, e.g. tighter limits */ }
  const order = await context.orders.findWithinOrg(input.orderId, context.organizationId); // tenancy from CONTEXT
  if (!order?.refundable) throw errors.NOT_ELIGIBLE();
  return context.payments.refund(input, { idempotencyKey: context.agent?.idempotencyKey, signal }); // forward signal
});
```

1. **Declare intentional failures** with `.errors()` — declared errors reach models with their message; undeclared throws are concealed ([reference/errors.md](../reference/errors.md#relationship-to-orpc-errors)).
2. **Scope by context, not by argument** — arguments are model-authored ([authorization.md](../security/authorization.md#multi-tenancy)).
3. **Forward `signal`** to downstream calls, or timeouts become fiction (SI-12).

## 6. Register

```ts
// src/capabilities.ts
export const capabilities = createCapabilityRegistry({
  orders: { checkRefundEligibility, refund: refundOrder, search: searchOrders },
  customers: { search: searchCustomers, get: getCustomer },
});
```

Startup now validates every `agent` block ([reference/metadata.md](../reference/metadata.md#validation-at-registry-build)). Log `capabilities.inspect()` once at boot — the excluded list is your "nothing leaked" review surface.

## Checklist per capability

- [ ] Description written for the model (≤ ~300 chars, says when to use it)
- [ ] `expose` minimal — only surfaces with a reason ([capability-exposure.md](capability-exposure.md))
- [ ] `sideEffect` and `risk` defensible in review
- [ ] Input schema strict; output schema minimal
- [ ] Intentional failures declared via `.errors()`
- [ ] Tenancy from context; `signal` forwarded
- [ ] Redaction if output carries fields models shouldn't see ([sensitive-data.md](../security/sensitive-data.md))
- [ ] Governance test added ([testing-capabilities.md](testing-capabilities.md))
