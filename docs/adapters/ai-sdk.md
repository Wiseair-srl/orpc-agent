# Adapter: Vercel AI SDK

> Package: `@orpc-agent/ai-sdk`. Peer: `ai@^5 || ^6`, `@orpc-agent/core`.

Converts a runtime's capabilities into AI SDK tools. Surface id: **`aiSdk`**. One capability exposed to `aiSdk` ⇢ one tool; the adapter is thin by contract ([adapter model](../architecture/adapter-model.md)) — discovery, validation, policy, approval, and execution all happen in the runtime.

## Supported `ai` versions

The peer range is `^5.0.0 || ^6.0.0`, and there is one code path — no version branch, no compat shim. The three `ai` APIs the adapter touches are unchanged across the majors: `tool()` has the same overloads, `jsonSchema()` only widened its input (it accepts a promise now), and a `Record<string, Tool>` still satisfies `ToolSet`. `jsonSchema()` without an explicit `validate` performs no validation in either major, so the runtime stays the single validation authority on both.

CI runs the package's suite and its typecheck against both majors on every PR (the `ai-sdk (ai v5)` and `ai-sdk (ai v6)` legs); the v6 leg is pinned by an aliased `ai-v6` devDependency rather than a floating install.

Two v6 changes are worth knowing even though they need no adapter change:

- **v6 has its own tool approval** (`needsApproval` on a tool, `ToolApprovalRequest` in the stream). The adapter never sets it — see [host loops with their own approval UX](#host-loops-with-their-own-approval-ux) for why the runtime has to be the only approval authority. A test asserts the field stays unset.
- **`toModelOutput` changed shape** (it now receives `{ toolCallId, input, output }`). The adapter does not set it, so on both majors the envelope reaches the model through the default JSON encoding.

Provider spec versions differ (`LanguageModelV2` in v5, `LanguageModelV3` in v6), but that is between your model provider and `ai` — the adapter never touches a model. v6 still accepts a v2 model, which is why one scripted model drives both CI legs.

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
| `scope` | no | `{ tags?, ids? }`; forwarded verbatim to `runtime.describe` — see below |
| `filter` | no | `(descriptor) => boolean`; conversation-shaping only, not authorization (SI-2) |
| `toolNaming` | no | Default `.`→`_` (`orders.refund` → `orders_refund`); `meta.adapters.aiSdk.toolName` overrides per capability; collisions throw at build |
| `signal` | no | Composed into every invocation (in addition to per-call abort from the loop) |

`toAISDKTools` awaits `runtime.describe("aiSdk", { actor, context, scope })`, so the returned set is already exposure- and discovery-policy-filtered *for this actor*. Build per request; caching a tool set across users leaks visibility decisions.

### `scope` vs `filter`

Having both invites confusion, so state it plainly: **`scope` decides what gets discovered; `filter` decides what survives discovery.** Neither is authorization (SI-2) — a capability excluded by either remains invocable by an authorized actor, and only exposure or a policy makes one unreachable.

```ts
const tools = await toAISDKTools(runtime, {
  actor, context,
  scope: { tags: ["devices"] },     // billing capabilities' discovery policies never run
  filter: (d) => d.risk === "low",  // of what was discovered, keep the low-risk ones
});
```

`scope` runs inside the runtime, before any discovery policy; `filter` runs here, on the descriptors that came back. On a large catalog re-composed per step, that is the difference between skipping the work and paying for it and dropping the result — see [reference/runtime.md](../reference/runtime.md#scope-discovery-shaping-never-an-authority-boundary) for the matching rules (`tags` is ANY; untagged capabilities match no `tags` scope).

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

## Host loops with their own approval UX

Agent frameworks that consume AI SDK tools (Mastra, and others) often ship their own tool-approval mechanism — a pre-execution "approve this tool call?" gate rendered by the host's stream. As of `ai@6` the SDK ships one itself: a tool's `needsApproval` suspends the loop and emits a `ToolApprovalRequest`. When a governed runtime sits underneath, **pick one authority, and it must be the runtime**:

- Host-loop approval decides on the *raw tool-call arguments, before `invoke`*: no canonical input hash (SI-5), no coordinator record, no `capability.approval_requested`/`approved` audit events, no expiry, no self-approval check. For governed operations that is a shadow approval system your audit trail cannot see.
- Running both gates double-prompts: the host asks, then the runtime's policy suspends the same call again.

So: **do not enable the host's — or `ai@6`'s — tool approval for governed tools.** Let orpc-agent's policies decide, and render the `approval-required` envelope — it is a typed tool result (`AISDKToolResult`), so your UI can render an approve/deny card generically from the stream's tool-result parts (or from a pending-approvals fetch), then call your `decide` + `resume` endpoints. The [Mastra task board example](../examples/mastra-task-board.md) is this exact wiring, working.

For requester-confirmed gates where the human is present in the chat, the composition from the [ADR-006 addendum](../architecture/decisions.md#adr-006-approvals-are-external-and-input-bound) fits streaming UIs: an inline `approvals.handler` holds the call open for `human-confirmation` types and returns `undefined` for everything else, deferring manager-type approvals to the coordinator flow unchanged.

## Cancellation

The AI SDK's per-call `abortSignal` flows into `runtime.invoke`, composes with the capability timeout, and reaches the handler (SI-12). Aborting the chat request cancels in-flight capability calls; the audit trail shows `capability.cancelled`.

## Testing

Don't test through a model. `@orpc-agent/testing` invokes with `surface: "aiSdk"` to assert exposure/policy behavior for this surface, and adapter conversion is covered by the conformance checklist ([adapters/testing.md](../adapters/testing.md#adapter-conformance)).

## Related

- [Adapter model](../architecture/adapter-model.md) · [Migrating hand-written tools](../guides/migrating-existing-tools.md) · [Reference: configuration](../reference/configuration.md#adapter-options)
