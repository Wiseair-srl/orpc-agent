# Adapter: Vercel AI SDK

> **Status:** Design draft — Proposed API, v0.1 target. Package: `@orpc-agent/ai-sdk`. Peer: `ai@^5`, `@orpc-agent/core`.

Converts a runtime's capabilities into AI SDK v5 tools. Surface id: **`aiSdk`**. One capability exposed to `aiSdk` ⇢ one tool; the adapter is thin by contract ([adapter model](../architecture/adapter-model.md)) — discovery, validation, policy, approval, and execution all happen in the runtime.

## Usage

```ts
import { generateText, stepCountIs } from "ai";
import { toAISDKTools } from "@orpc-agent/ai-sdk";

// Inside your authenticated request handler — build tools PER REQUEST:
const tools = await toAISDKTools(runtime, {
  actor: sessionActor(req),          // authenticated identity, never model-derived (SI-3)
  context: await createAppContext(req),
});

const result = await generateText({
  model,                              // any provider — the adapter never touches it
  system: SUPPORT_SYSTEM_PROMPT,
  messages,
  tools,
  stopWhen: stepCountIs(8),
});
```

### Options (`AISDKToolsOptions`)

| Option | Required | Notes |
|---|---|---|
| `actor` | yes | Bound into every call of this tool set |
| `context` | yes | The app's oRPC context for this request |
| `filter` | no | `(descriptor) => boolean`; conversation-shaping only, not authorization (SI-2) |
| `toolNaming` | no | Default `.`→`_` (`orders.refund` → `orders_refund`); `meta.adapters.aiSdk.toolName` overrides per capability; collisions throw at build |
| `signal` | no | Composed into every invocation (in addition to per-call abort from the loop) |

`toAISDKTools` awaits `runtime.describe("aiSdk", { actor, context })`, so the returned set is already exposure- and discovery-policy-filtered *for this actor*. Build per request; caching a tool set across users leaks visibility decisions.

## What each generated tool contains

- `description` — from `meta.description` (plus the suffix `" Requires approval."` when the descriptor says `requiresApproval` — cheap, honest model guidance).
- `inputSchema` — the capability's input schema converted to JSON Schema (via `@orpc-agent/core/schema`) and wrapped with the AI SDK's `jsonSchema()` helper. The adapter does **not** pre-validate; `execute` forwards raw arguments so the runtime remains the single validation authority (pipeline stage 5).
- `execute(args, { abortSignal })` — calls `runtime.invoke(capabilityId, args, { actor, context, surface: "aiSdk", signal })` and translates the envelope.

## Result shape

Tool results are **always** a structured envelope (`AISDKToolResult`) — deterministic for the model, uniform across capabilities:

```jsonc
// completed
{ "status": "ok", "data": { /* redacted output */ } }

// approval-required
{ "status": "approval-required", "approvalId": "apr_9",
  "message": "Awaiting approval: Refund of $649 exceeds $500." }

// failed / cancelled — exposeToModel errors
{ "status": "error", "error": { "code": "POLICY_DENIED",
  "message": "Refunds of $5000 or more cannot be issued by agents.", "retryable": false } }

// failed — concealed errors (SI-9)
{ "status": "error", "error": { "code": "INTERNAL_ERROR",
  "message": "The operation failed.", "retryable": false } }
```

Design choices, stated:

- **Return, don't throw.** Throwing inside `execute` produces provider-dependent tool-error handling; a returned envelope keeps the model in the loop with typed, uniform feedback it can reason about (retry input validation, stop on denial, report approval state).
- `INPUT_INVALID` includes `error.details` (issue paths) so the model can self-correct — the one case where details cross the boundary, because the model authored the data.
- `approval-required` is not an error: the model's correct behavior is to inform the user and stop, and the shape says so.

## Approval flow in a chat loop

The tool result cannot wait for a human (tool calls should return promptly; approvals may take hours). Pattern:

```text
model calls orders_refund → { status: "approval-required", approvalId }
model tells user; loop ends this turn
… human approves in your dashboard (runtime.approvals.decide) …
your app calls runtime.resume(approvalId, { context }) from the dashboard/worker
app posts the outcome into the conversation (or the user asks again and the
model re-invokes — new execution, new decision, consumed approvals don't re-fire)
```

The inline `approvals.handler` mode exists for short-latency confirmation UIs (the human is present and the transport can hold the call open) — see [guides/human-approval.md](../guides/human-approval.md#inline-confirmation).

## Cancellation

The AI SDK's per-call `abortSignal` flows into `runtime.invoke`, composes with the capability timeout, and reaches the handler (SI-12). Aborting the chat request cancels in-flight capability calls; the audit trail shows `capability.cancelled`.

## Testing

Don't test through a model. `@orpc-agent/testing` invokes with `surface: "aiSdk"` to assert exposure/policy behavior for this surface, and adapter conversion is covered by the conformance checklist ([adapters/testing.md](../adapters/testing.md#adapter-conformance)).

## Related

- [Adapter model](../architecture/adapter-model.md) · [Migrating hand-written tools](../guides/migrating-existing-tools.md) · [Reference: configuration](../reference/configuration.md#adapter-options)
