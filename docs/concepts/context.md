# Context and actors

> **Status:** Stable — 1.0.

Two request-scoped objects travel with every invocation and are easy to conflate. They answer different questions:

- **Actor** — *who* is asking (a security identity).
- **Execution context** — *what the application knows* about this request (data and services).

And one distinction that anchors the whole security model: **the model is not the actor** (SI-3). A model chooses arguments; it never has identity. The actor is whoever authenticated to your application — the support agent whose chat session drives the model, the service account behind an automation, the MCP client's OAuth principal.

## Actor

```ts
type Actor = {
  id: string;                                            // stable within your app
  kind: "user" | "service" | "automation" | "anonymous";
  displayName?: string;
  attributes?: Record<string, unknown>;                  // roles, permissions, orgId — app-defined
};
```

Rules:

- Constructed by the adapter/app from **authenticated** transport credentials — never from tool arguments, prompt content, or anything a model wrote (nothing model-authored can change identity).
- Anonymous access is explicit (`kind: "anonymous"`), never a missing actor — a missing actor is `UNAUTHENTICATED`.
- `attributes` is where your app puts what policies need (`{ roles: ["support"], permissions: ["orders:refund"], orgId: "org_1" }`). The runtime never interprets it; your policies do.
- In audit events only `{ id, kind }` is recorded by default.

The actor also appears as the **approver** in approval decisions — same type, different role, and the runtime enforces they differ (SI-4).

## Execution context

The `context` you pass to `invoke` **is your application's oRPC context** — the same object your procedures and middleware already consume. oRPC Agent does not define its shape and does not prescribe a database, frontend, or auth provider.

```ts
type AppContext = {
  db: Database;
  session: Session | null;
  organizationId: string;
  locale: string;
  // whatever your app already has
};

await runtime.invoke("orders.search", input, {
  actor,
  context: await createAppContext(req),   // your existing context factory
  surface: "direct",
});
```

Because it is the same context, middleware that enforces tenancy or loads membership works identically for agent traffic — the core of [ADR-008](../architecture/decisions.md#adr-008-existing-orpc-middleware-remains-authoritative).

### What the runtime injects: `context.agent`

At pipeline stage 11 the runtime extends the context with one namespaced key:

```ts
type AgentInvocationInfo = {
  executionId: string;
  capabilityId: string;
  surface: ExposureSurface;
  actor: Actor;
  approval?: { id: string; approver: Actor };
  correlationId?: string;
  idempotencyKey: string;
};
```

Handlers and middleware read `context.agent` to react to agent-originated calls — stricter rate limits, extra logging, idempotency keys for downstream calls. On non-agent invocations (plain HTTP traffic) `context.agent` is `undefined`; `agentProcedure` types it as optional so code checks before use.

## Capability context providers

Applications often want to hand the *model* structured situational context — the currently open record, active filters, selected rows — so it calls capabilities sensibly. oRPC Agent takes no position on how you assemble that (it is prompt/UI territory), with one rule:

> Situational context may inform what the model *asks for*; it must never be the basis of what the runtime *allows*.

Put the current `organizationId` in the execution context and enforce it in middleware/policies; put "the user is looking at order #42" in the prompt. The first is security, the second is convenience. Conflating them is how confused-deputy bugs happen ([security/authorization.md](../security/authorization.md#multi-tenancy)).

## Context is not memory

"Context" here is request-scoped application data. Conversation history, long-term memory, and retrieved documents belong to your agent loop and are outside oRPC Agent's scope ([glossary](../glossary.md)). If retrieved/model-visible content flows into capability *inputs*, it is untrusted data — see [prompt injection](../security/prompt-injection.md#what-you-must-still-do).

## Related

- Guide: [application-context.md](../guides/application-context.md) · Reference: [core.md](../reference/core.md#supporting-types)
