# Guide: migrating existing tools

> **Status:** Implemented in v0.1. For teams with hand-written AI SDK tools (or similar) moving to governed capabilities — incrementally, tool by tool.

## Where you are

```ts
// Before: a hand-rolled tool — duplicated schema, inlined logic, ad-hoc auth, invisible failures
const refundTool = tool({
  description: "Refund an order",
  inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
  execute: async ({ orderId, amount }) => {
    const user = getCurrentUser();                    // ambient identity
    if (!user.permissions.includes("refund")) return "not allowed";   // stringly-typed failure
    return db.refunds.create({ orderId, amount });    // business logic lives in the tool
  },
});
```

Five debts, one per line: schema duplicated from the API layer; identity from ambient state; authorization hand-rolled per tool; errors as prose; logic unreachable from UI/tests/API without copy-paste.

## Where you're going

```ts
// After: one procedure, governed, exposed
export const refundOrder = agentBase
  .meta({ agent: { description: "Refund an order, fully or partially.",
    expose: { aiSdk: true, direct: true }, sideEffect: "write", risk: "high" } })
  .use(requirePermission("orders:refund"))
  .input(RefundInput)                       // the schema your API already had
  .output(RefundResult)
  .handler(refundHandler);                  // the logic your service layer already had

const tools = await toAISDKTools(runtime, { actor, context });   // replaces the hand-rolled map
```

## Step-by-step (per tool)

**1. Find or extract the procedure.** Most hand-written tools shadow an existing oRPC procedure — use it. If the logic lives only in the tool, extract it into a procedure now (that refactor is the migration's real work and pays off for every surface).

**2. Reuse schemas.** Your tool's `inputSchema` and the procedure's `.input()` were siblings separated at birth; keep the stricter one, delete the other. Add `.output()` if missing — output validation (stage 12) and redaction hang off it.

**3. Move identity from ambient to explicit.** `getCurrentUser()` inside `execute` becomes the `actor`/`context` pair built once per request in your handler ([application-context.md](application-context.md)). The tool body stops knowing who's calling; the pipeline knows instead.

**4. Move authorization down, governance up.** Permission checks inside `execute` become oRPC middleware (authoritative, shared with all callers); agent-specific rules (thresholds, approvals, surface limits) become policies ([adding-policies.md](adding-policies.md)). The `return "not allowed"` string becomes a typed `FORBIDDEN` or `POLICY_DENIED` the model can actually reason about.

**5. Convert error prose to contracts.** Intentional failures (`"order not found"`, `"not eligible"`) become declared `.errors()` — model-visible with real messages. Everything else gets concealed automatically (SI-9), which is a *behavior change to welcome*: your stack traces stop leaking into model context.

**6. Annotate and expose.** `sideEffect`/`risk` honestly; `expose: { aiSdk: true }` to match today's reach — widen later deliberately ([capability-exposure.md](capability-exposure.md)).

**7. Swap the tool set.** Replace the hand-rolled record with `toAISDKTools`. Tool names survive via the default `.`→`_` mapping or `meta.adapters.aiSdk.toolName` if you must keep exact legacy names mid-migration.

**8. Add the tests you couldn't write before.** Exposure, denial, approval, redaction — [testing-capabilities.md](testing-capabilities.md). This is the payoff step; hand-rolled tools had no governance to test.

## Incremental coexistence

Migrate one tool at a time — the AI SDK accepts a merged record:

```ts
const tools = {
  ...legacyTools,                                          // untouched, for now
  ...(await toAISDKTools(runtime, { actor, context })),    // governed, growing
};
```

Order the queue by risk: migrate `write`/`destructive`/`external` tools first (they're why you're here), reads last. Delete each legacy tool the same PR its capability lands — coexistence is a ramp, not a destination.

## Behavior changes to expect

| Before | After | Why |
|---|---|---|
| Invalid args → model sees Zod throw text | `INPUT_INVALID` envelope with issue paths | Uniform, self-correctable (stage 5) |
| Auth failure → ad-hoc string | Typed `FORBIDDEN`/`POLICY_DENIED` | Model stops retrying nonsense |
| Internal throw → stack into model context | `"The operation failed."` + full detail in logs/audit | SI-9 |
| High-stakes call → executed immediately | possibly `approval-required` envelope | You added a gate that didn't exist |
| Nothing recorded | Full audit trail incl. denials | ADR-010 |

Expect prompts to need one adjustment: models handle the structured result envelope well, but system prompts that parsed legacy string errors ("if the tool says 'not allowed'…") should be updated to the envelope vocabulary.

## From other stacks

Same recipe from OpenAI Agents SDK / LangChain-style tools: the tool's schema → procedure input; the function body → handler; ambient auth → actor/context; framework-specific error strings → declared errors. The destination is identical because the destination is just your application, governed.
