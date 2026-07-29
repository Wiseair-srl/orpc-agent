# Getting started

> **Status:** Stable — 1.0, published to npm. Install the packages from npm (`pnpm add @orpc-agent/core @orpc/server`); inside this repository the walkthrough below also works as written against the workspace packages, and the [customer-support example](examples/customer-support-agent.md) runs it end to end.

Goal: from an existing oRPC app to a governed AI-SDK tool call in five steps — then the one-line paths to everything else.

## Prerequisites

- An oRPC application (`@orpc/server`) with typed procedures and a context factory
- Vercel AI SDK v5 or v6 for the model loop (any provider)
- Node 20+, `pnpm`

```bash
pnpm add @orpc-agent/core @orpc-agent/ai-sdk
```

## 1. Type your base for agents

```ts
// src/orpc.ts
import { os } from "@orpc/server";
import { agentProcedure } from "@orpc-agent/core";

export const base = os.$context<AppContext>().use(requireSession);   // you already have this
export const agentBase = agentProcedure(base);                       // adds typing only
```

## 2. Annotate a procedure → it becomes a capability

```ts
// src/capabilities/orders.ts
import * as z from "zod";
import { agentBase } from "../orpc";

export const searchOrders = agentBase
  .meta({
    agent: {
      description: "Search orders by customer email or order number.",
      expose: { aiSdk: true },        // deny-by-default: only what you name (SI-1)
      sideEffect: "read",
      risk: "low",
    },
  })
  .input(z.strictObject({ query: z.string().min(2), limit: z.number().int().max(50).default(10) }))
  .output(z.object({ orders: z.array(OrderSummary) }))
  .handler(async ({ input, context, signal }) => ({
    orders: await context.orders.search(input, { signal }),
  }));
```

Existing routers, HTTP handlers, and OpenAPI output are untouched — the `agent` block is inert outside the agent runtime.

## 3. Register and create the runtime

```ts
// src/agent.ts
import { createCapabilityRegistry, createAgentRuntime, defineGovernance } from "@orpc-agent/core";
import { searchOrders } from "./capabilities/orders";

export const capabilities = createCapabilityRegistry({
  orders: { search: searchOrders },
});

export const runtime = createAgentRuntime({
  governance: defineGovernance({ registry: capabilities }),
  // policies, approvals, audit, tracing — all optional to start; add as you grow
});
```

Startup validates every capability's metadata and fails loudly on problems.

## 4. Hand tools to your model loop

```ts
// src/api/chat.ts
import { streamText, stepCountIs } from "ai";
import { toAISDKTools } from "@orpc-agent/ai-sdk";
import { runtime } from "../agent";

export async function POST(req: Request) {
  const session = await requireSession(req);
  const tools = await toAISDKTools(runtime, {
    actor: { id: session.userId, kind: "user" },     // authenticated identity — never the model (SI-3)
    context: await createAppContext(session),
  });

  return streamText({ model, messages: await req.json(), tools, stopWhen: stepCountIs(5) })
    .toUIMessageStreamResponse();
}
```

The model can now call `orders_search`. Input is validated by your schema, your middleware runs, errors come back model-safe, and every call is traceable.

## 5. Verify without a model

```bash
pnpm add -D @orpc-agent/testing
```

```ts
import { createAgentTestRuntime } from "@orpc-agent/testing";
import { capabilities } from "../src/agent";

test("search is exposed to aiSdk and validates input", async () => {
  const t = createAgentTestRuntime({ registry: capabilities, context: testContext });
  expect((await t.describe("aiSdk")).map(d => d.id)).toContain("orders.search");

  const bad = await t.invoke("orders.search", { query: "" }, { surface: "aiSdk" });
  expect(bad.error.code).toBe("INPUT_INVALID");
});
```

## Growing up from here

Each next need is one addition, not a rewrite — the simple path and the governed path are the same abstractions:

| Need | Add | Guide |
|---|---|---|
| A write operation | `sideEffect: "write"`, strict schema, declared errors | [defining-capabilities](guides/defining-capabilities.md) |
| "Over $500 needs a manager" | a policy + `approvals` config | [adding-policies](guides/adding-policies.md), [human-approval](guides/human-approval.md) |
| Compliance trail | `audit:` sink (a table + one insert) | [auditing](guides/auditing.md) |
| Traces in your APM | `tracing: createOpenTelemetryTracing()` | [adapters/opentelemetry](adapters/opentelemetry.md) |
| External MCP clients | `@orpc-agent/mcp` + per-session identity | [adapters/mcp](adapters/mcp.md) |
| Hide fields from models | `redact.output` | [sensitive-data](security/sensitive-data.md) |
| Migrate hand-written tools | one tool at a time | [migrating-existing-tools](guides/migrating-existing-tools.md) |

Recommended reading order after this page: [concepts/capabilities](concepts/capabilities.md) → [concepts/lifecycle](concepts/lifecycle.md) → [security/security-model](security/security-model.md) → the [customer-support example](examples/customer-support-agent.md).
