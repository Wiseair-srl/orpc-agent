# Example: Mastra task board

> A thin full-stack app under `examples/mastra-task-board/` in the repository. `pnpm --filter mastra-task-board-example demo` prints the end-to-end flow below deterministically (no key, no network); `… dev` serves the real thing.

Where the [customer-support agent](customer-support-agent.md) is the exhaustive reference, this example is the minimal *full-stack* one: a React task board, a [Mastra](https://mastra.ai) agent, and four capabilities shared between them. It exists to show two things concretely:

1. **An agent-framework integration is one function call.** `toAISDKTools` output plugs straight into a Mastra `Agent` — the adapter targets the AI SDK tool interface, and Mastra consumes those tools natively. No Mastra-specific adapter package is needed.

   The adapter's peer range is `ai@^5 || ^6` ([supported versions](../adapters/ai-sdk.md#supported-ai-versions)), so it fits a Mastra app on either major; the tool set is the same object in both. This example pins `ai@^5` — pinning is the example's choice, not the adapter's constraint.
2. **The two-surface architecture in working code.** The UI calls procedures as plain typed oRPC (`/rpc`); the model reaches the same procedures only through the governed runtime. Middleware runs on both paths; governance (exposure, policies, approvals, redaction, audit) applies to the model's path.

```text
you ──┬─ board UI ── typed oRPC client ──── /rpc ────────► procedures (middleware runs)
      │                                                        ▲
      └─ chat ── /api/chat ── Mastra Agent ── AI SDK tools ────┤
                              (OpenRouter, any model)          │ governed: exposure · validation
                                                               │ policies · approvals · redaction
you ── approvals panel ── /api/approvals ── decide + resume ───┘ audit ledger
```

## Capability inventory

| Capability | sideEffect / risk | Governance |
|---|---|---|
| `tasks.list` | read / low | Output redaction: internal `notes` never reach the model; the board UI sees them |
| `tasks.create` | write / medium | Policy: `priority: "urgent"` ⇒ human approval (“urgent tasks page the on-call rotation”) |
| `tasks.move` | write / low | Audited like every write |
| `tasks.delete` | **destructive / high** | Static approval gate (`human-confirmation`) — suspend, human decides, `resume` executes once |

## The Mastra integration, in full

```ts
// src/agent.ts — this is all of it
import { Agent } from "@mastra/core/agent";
import { toAISDKTools } from "@orpc-agent/ai-sdk";

const tools = await toAISDKTools(app.runtime, {
  actor: actorFrom(session),        // authenticated identity, never the model (SI-3)
  context: app.contextFor(session), // this request's oRPC context
});

const agent = new Agent({
  id: "task-board-assistant",
  name: "Task board assistant",
  instructions: INSTRUCTIONS,       // includes how to read result envelopes
  model,                            // "openrouter/<any-slug>" — model-agnostic
  tools,                            // AI SDK tools (v5 or v6), consumed natively
});

const result = await agent.generate(messages, { maxSteps: 8 });
```

Tools are built **per request** — they close over the actor and context, so caching an agent across users would leak visibility decisions. Constructing the `Agent` object is cheap; do it in the request handler.

Model choice is an environment variable: Mastra's model router takes `openrouter/<slug>` and reads `OPENROUTER_API_KEY`, so any OpenRouter-served model works without code changes. Without a key the app boots with AI disabled and the board fully functional.

## The end-to-end flow

One user message; the scripted demo and the live app produce the same governed sequence:

```text
you: "Move the flaky test task to done, then delete the Acme contract task."

tool tasks_list {}                        → { status: "ok", data: { tasks: [...] } }   # notes redacted
tool tasks_move {"id":"t_3","status":"done"} → { status: "ok", data: {...} }
tool tasks_delete {"id":"t_2"}            → { status: "approval-required",
                                              approvalId: "apr_…" }                    # suspended, not executed
assistant: "Moved it. Deleting “Renew Acme contract” needs your confirmation."

… you click Approve in the approvals panel …
runtime.approvals.decide(id, { status: "approved", approver })
runtime.resume(id, { context })           → { status: "completed",
                                              output: { deleted: true, … } }          # exactly once
```

The audit ledger for that turn, as the UI's bottom strip shows it:

```text
capabilities.discovered              aiSdk   4 capabilities visible
capability.requested   tasks.list    aiSdk
capability.started     tasks.list    aiSdk
capability.completed   tasks.list    aiSdk
capability.requested   tasks.move    aiSdk
capability.started     tasks.move    aiSdk
capability.completed   tasks.move    aiSdk
capability.requested   tasks.delete  aiSdk
capability.approval_requested        aiSdk   "Approval is required for tasks.delete"
capability.approved    tasks.delete  aiSdk   by u_you
capability.started     tasks.delete  aiSdk
capability.completed   tasks.delete  aiSdk
```

The model cannot invent capabilities: a scripted call to a nonexistent `database_drop` tool is rejected by the loop's tool validation and never reaches the runtime — covered in the example's tests, along with redaction, both approval paths, and the audit sequence above.

## Self-approval, disabled deliberately

The demo has one person playing requester and approver, so the runtime is configured with `rejectSelfApproval: false` — the documented exception for requester-confirmed `human-confirmation` gates. Keep the default (`true`) whenever those are different people; the [customer-support example](customer-support-agent.md) shows that arrangement, including the `APPROVAL_SELF_APPROVAL` failure at resume.

## Run it

```bash
pnpm install && pnpm build
pnpm --filter mastra-task-board-example dev    # board on :5173, server on :3000
pnpm --filter mastra-task-board-example demo   # scripted flow, no key needed
pnpm --filter mastra-task-board-example test
```

Chat needs an [OpenRouter](https://openrouter.ai/keys) key in `examples/mastra-task-board/.env` (`OPENROUTER_API_KEY`, optional `OPENROUTER_MODEL`). Node ≥ 22.13 (Mastra's floor; the rest of the monorepo needs ≥ 20.19).

## Related

- [Adapter: Vercel AI SDK](../adapters/ai-sdk.md) — the surface this example rides on
- [Guide: human approval](../guides/human-approval.md) — suspend/resume semantics
- [Example: customer-support agent](customer-support-agent.md) — the exhaustive reference app
