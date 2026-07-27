# oRPC Agent

> Make agents first-class clients of your oRPC application.

Expose the same typed oRPC procedures to application UIs, AI runtimes, MCP clients, workflows, and tests — with shared validation, permissions, approvals, execution policies, and observability.

**⚠️ Project status: v0.1 implemented in-repo, not yet published.** This repository contains the complete design documentation **and** the v0.1 implementation built from it: five packages under [`packages/`](packages) (core, ai-sdk, mcp, opentelemetry, testing) and the runnable [customer-support reference app](examples/customer-support). The full governance test suite runs in CI (`pnpm install && pnpm build && pnpm test`); npm publication is pending scope registration ([Q1](docs/open-questions.md#q1)). Follow the [ROADMAP](ROADMAP.md).

```bash
# try it from a clean checkout
pnpm install && pnpm build && pnpm test
pnpm --filter customer-support-example demo   # the documented end-to-end flow, scripted
pnpm --filter mastra-task-board-example dev   # full-stack example: board UI + Mastra agent
pnpm docs:dev                                 # browse the documentation site locally
```

## The idea

An AI agent must not call business logic directly. It requests a **capability**: an ordinary oRPC procedure enriched with explicit governance metadata — exposure per surface, side-effect and risk classification, policies, approvals, redaction. One definition serves every client:

> Define a capability once. Expose it through multiple governed surfaces.

```text
        Model provider / agent runtime
                     |
                     v
             Protocol adapter
      @orpc-agent/ai-sdk   @orpc-agent/mcp
                     |
                     v
            oRPC Agent runtime
   exposure · validation · policies · approvals
     · timeout/cancel · audit · tracing
                     |
                     v
             oRPC capabilities
   your procedures — middleware and app
     authorization run here, unchanged
                     |
                     v
     application services and infrastructure
```

## Why

Teams with typed oRPC procedures keep re-implementing them as hand-written AI tools: duplicated schemas that drift, ad-hoc auth per tool, string errors that leak internals, no audit trail, no approval story. Meanwhile "the model can't see the tool" gets mistaken for security.

oRPC Agent is the layer between agent runtimes and business logic: it agent-enables an **existing** oRPC application without a new full-stack framework, and treats the model end of every surface as untrusted input. It stays deliberately narrow — UI-independent, database-independent, auth-provider-independent, model-provider-independent, workflow-engine-independent.

## Quick start

```ts
import { os } from "@orpc/server";
import { agentProcedure, createCapabilityRegistry, createAgentRuntime } from "@orpc-agent/core";
import { toAISDKTools } from "@orpc-agent/ai-sdk";
import * as z from "zod";

// 1. Type your existing base for agents (adds typing only)
const agentBase = agentProcedure(os.$context<AppContext>().use(requireSession));

// 2. An annotated procedure is a capability — deny-by-default exposure
export const searchOrders = agentBase
  .meta({
    agent: {
      description: "Search orders by customer email or order number.",
      expose: { aiSdk: true },
      sideEffect: "read",
      risk: "low",
    },
  })
  .input(z.strictObject({ query: z.string().min(2) }))
  .output(z.object({ orders: z.array(OrderSummary) }))
  .handler(async ({ input, context, signal }) => ({ orders: await context.orders.search(input, { signal }) }));

// 3. Registry + governed runtime
const capabilities = createCapabilityRegistry({ orders: { search: searchOrders } });
const runtime = createAgentRuntime({ registry: capabilities });

// 4. Per-request tools for your model loop — actor = authenticated identity, never the model
const tools = await toAISDKTools(runtime, { actor, context });
```

Full walkthrough: [docs/getting-started.md](docs/getting-started.md).

## Core features (v0.1, implemented)

- **Capabilities, not tools** — procedures are the single source of truth; "tool" is just an adapter representation ([ADR-001](docs/architecture/decisions.md#adr-001-orpc-procedures-are-the-source-of-truth), [ADR-002](docs/architecture/decisions.md#adr-002-capability-is-the-internal-abstraction))
- **Explicit, per-surface exposure** — deny by default across `direct` / `aiSdk` / `mcp` / `workflow` / `test`
- **A single governed pipeline** — validation, policies, approvals, timeout/cancellation, retries, redaction, error normalization: [15 specified stages](docs/architecture/execution-pipeline.md)
- **Deterministic policies** — allow / deny / hide / require-approval, deny-wins precedence, fail-closed
- **Input-bound approvals** — hash-bound to the exact validated input, single-use, expiring, no self-approval
- **Two-face errors** — model-safe public face, private diagnostics; concealment for hidden capabilities
- **Structured audit events + OpenTelemetry tracing** — storage-neutral, payload-free by default
- **Deterministic testing** — assert exposure, policies, approvals, redaction with no LLM in the loop

## Security model in one paragraph

Everything model-side of the adapter is untrusted. Twelve binding invariants (SI-1…SI-12) govern the design: deny-by-default exposure; enforcement at execution time (tool filtering is UX, not security); the model is never the actor; approvals come from outside the model and bind the exact input; policy failures fail closed; hidden and nonexistent capabilities are indistinguishable; internals never reach models; audit and traces carry no payloads by default; writes are never auto-retried; every execution is bounded and cancellable. Your oRPC middleware remains the authoritative authorization layer on every call. **Not claimed:** solving prompt injection (impact is bounded, not occurrence), exactly-once execution, or safety without application-level authorization. Read: [security model](docs/security/security-model.md), [threat model](docs/security/threat-model.md).

## Packages

| Package | Purpose |
|---|---|
| `@orpc-agent/core` | Capability model, registry, runtime, policies, approvals, errors, events — no provider/protocol deps |
| `@orpc-agent/ai-sdk` | Vercel AI SDK v5 tools over the runtime |
| `@orpc-agent/mcp` | MCP server adapter with per-session identity |
| `@orpc-agent/opentelemetry` | Tracing adapter (spans + conventions) |
| `@orpc-agent/testing` | Deterministic governance testing |

Boundaries and rules: [package-boundaries](docs/architecture/package-boundaries.md). Scope name is a placeholder pending registration ([ADR-011](docs/architecture/decisions.md#adr-011-npm-scope-and-project-independence)).

## Examples

**Customer-support agent** (flagship): the dashboard UI, an AI assistant, and an MCP endpoint share nine governed capabilities: refunds over $500 require manager approval (input-hash-bound, single-use); sending customer messages requires human confirmation; refunds aren't exposed over MCP at all; PII is redacted from model-visible output; every step lands in the audit trail. The full narrative, code, and failure branches: [docs/examples/customer-support-agent.md](docs/examples/customer-support-agent.md).

**Mastra task board** (full-stack): a React board on plain typed oRPC plus a [Mastra](https://mastra.ai) chat agent reaching the same four capabilities through the governed runtime — approvals in the UI, redaction, live audit ledger. Model-agnostic via OpenRouter (`pnpm --filter mastra-task-board-example dev`; needs Node ≥ 22.13). Walkthrough: [docs/examples/mastra-task-board.md](docs/examples/mastra-task-board.md).

## Non-goals

No agent loop, planner, prompts, or memory. No workflow engine (durable execution integrates via adapters). No bundled databases for approvals or audit. No auth provider. No UI framework. No exactly-once claims. Not a replacement for oRPC — it requires it. Full list: [ROADMAP — non-goals](ROADMAP.md#non-goals-permanent).

## Roadmap

**v0.1 "Governed core"**: the five packages + reference example, per the [implementation brief](docs/implementation/brief.md). **v0.2 "Durability seams"**: persistent approval coordination, first workflow-engine adapter, MCP dynamic listings. **Later**: streaming capabilities, quotas, more adapters. Details and open questions: [ROADMAP.md](ROADMAP.md), [docs/open-questions.md](docs/open-questions.md).

## Contributing

Design review, security analysis, and doc fixes are the most valuable contributions right now; implementation proceeds milestone by milestone. Start with [CONTRIBUTING.md](CONTRIBUTING.md); security reports via [SECURITY.md](SECURITY.md); conduct per the [Code of Conduct](CODE_OF_CONDUCT.md); decisions per [GOVERNANCE.md](GOVERNANCE.md).

## License and independence

MIT. oRPC Agent is an **independent community project** — not affiliated with, endorsed by, or maintained by the oRPC project. It builds on oRPC with respect and gratitude; if the oRPC maintainers ever want this work closer to home, the door is open ([ADR-011](docs/architecture/decisions.md#adr-011-npm-scope-and-project-independence)).
