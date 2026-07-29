# Reference: runtime

> **Status:** Implemented in v0.1. Stability: experimental.

Package: `@orpc-agent/core`. The runtime is the governed execution engine; every surface funnels through it. Behavior is normatively specified by the [execution pipeline](../architecture/execution-pipeline.md) — this page defines the API contract.

---

## `createAgentRuntime`

```ts
function createAgentRuntime<TContext>(options: AgentRuntimeOptions<TContext>): AgentRuntime<TContext>;

type AgentRuntimeOptions<TContext> = {
  registry: CapabilityRegistry;
  policies?: AgentPolicy[];                      // runtime-level, evaluated in order before meta.policies
  approvals?: ApprovalsConfig;
  audit?: AuditSink | AuditSink[] | { sinks: AuditSink[]; strict?: boolean; onSinkError?: (err: unknown, event: AgentAuditEvent) => void };
  tracing?: TracingAdapter;
  defaults?: {
    timeoutMs?: number;             // 30_000
    policyTimeoutMs?: number;       // 5_000
    approvalExpiresInMs?: number;   // 900_000 (15 min)
  };
  now?: () => Date;                 // clock injection; default system clock
};

type ApprovalsConfig = {
  coordinator?: ApprovalCoordinator;                       // default: createInMemoryApprovalCoordinator()
  handler?: (req: ApprovalRequest) => Promise<ApprovalDecision | undefined>; // inline mode; `undefined` defers this request to the coordinator flow (ADR-006 addendum)
  rejectSelfApproval?: boolean;                            // default true (SI-4)
};
```

**Generic parameter.** `TContext` — the application's oRPC context type; enforced on `invoke`/`describe`/`resume` options so agent calls carry the same context procedures already expect.

**Construction behavior.** Pure and synchronous: wires configuration, verifies the registry's schemas are convertible for exposed schema-consuming surfaces, and returns. No I/O.

**`runtime.registry`.** The runtime exposes its registry read-only. Adapters read capability meta from it for protocol concerns descriptors deliberately omit (tool-name overrides, MCP annotations) — see [ADR-012](../architecture/decisions.md#adr-012-as-built-api-deltas-for-v01).

**`runtime.policies`.** The identity of the runtime-level policies, in evaluation order, composites flattened, frozen:

```ts
readonly policies: readonly { name: string; phases: readonly PolicyPhase[] }[];
```

Name and phases only — never `evaluate`. A decision is meaningful only inside the pipeline (shared batch deadline, fail-closed on throw, audit record), so the closure is not handed out; a policy evaluated outside it would produce an answer that looks authoritative and is not. The names are the same ones audit events already record in `PolicyDecisionRecord.policy`.

This is the configuration, not its effect. **Governance tooling may report that these policies exist; it may not conclude which capabilities they gate** — that depends on the actor, surface, input and context of a real invocation. [`@orpc-agent/cli`](cli.md) records this list so that removing a runtime policy registers as drift ([ADR-016](../architecture/decisions.md#adr-016-runtime-policies-are-part-of-the-governance-contract)).

---

## `runtime.invoke`

```ts
invoke<O = unknown>(
  capabilityId: string,
  input: unknown,                    // RAW input; the runtime validates (adapters must not pre-validate)
  options: ExecutionOptions<TContext>,
): Promise<ExecutionResult<O>>;

type ExecutionOptions<TContext> = {
  actor: Actor;
  context: TContext;
  surface?: ExposureSurface;         // default "direct"
  signal?: AbortSignal;
  correlationId?: string;            // threads conversation/run ids into events and traces
};
```

**Lifecycle.** Runs pipeline stages 2–15. **Never throws for governed failures** — resolution misses, validation failures, denials, timeouts, and handler errors all return envelopes. It can only reject on programmer error (e.g., options omitted entirely).

**Returns.**

```ts
type ExecutionResult<O> =
  | { status: "completed";          executionId: string; output: O }
  | { status: "approval-required";  executionId: string; approval: ApprovalRecord }
  | { status: "failed";             executionId: string; error: CapabilityError }
  | { status: "cancelled";          executionId: string; error: CapabilityError };  // code TIMEOUT | CANCELLED
```

`output` is the **redacted** output (stage 13). The unredacted value never leaves the runtime.

**Example (direct surface).**

```ts
const result = await runtime.invoke(
  "orders.search",
  { query: "alice@example.com" },
  { actor: { id: "u_1", kind: "user" }, context, surface: "direct" },
);
if (result.status === "completed") console.log(result.output);
```

---

## `runtime.describe`

```ts
describe(
  surface: ExposureSurface,
  options: { actor: Actor; context: TContext },
): Promise<CapabilityDescriptor[]>;

type CapabilityDescriptor = {
  id: string;
  description: string;
  inputSchema: JsonSchemaObject;     // converted via core/schema
  sideEffect: SideEffect;
  risk: RiskLevel;
  tags: string[];
  requiresApproval?: boolean;        // statically required, or discovery policies said require-approval
};
```

**Lifecycle.** Runs the discovery pipeline: exposure filter → discovery-phase policies (deny/hide exclude; require-approval annotates; errors exclude, fail closed) → emits `capabilities.discovered`. Output schemas are omitted by default — models receive the minimum needed to call correctly.

Descriptors are advisory for the *client*; every later `invoke` re-checks everything (SI-2).

---

## `runtime.resume`

```ts
resume<O = unknown>(
  approvalId: string,
  options: { context: TContext; signal?: AbortSignal },
): Promise<ExecutionResult<O>>;
```

**Lifecycle.** Re-enters the pipeline at stage 8: verifies the record (`approved`, unexpired, unconsumed, approver ≠ requester per config), re-hashes and compares stored input (SI-5), re-validates against the current schema, marks the record consumed atomically, then continues stages 9–15 under a **new** `executionId`, running as the **original actor** with `context.agent.approval = { id, approver }`.

No `actor` parameter by design: the requesting identity is bound in the record; resumption must not re-attribute the execution. The caller supplies fresh `context` because application context (db handles, loaders) is not serializable.

**Failure codes.** `APPROVAL_PENDING`, `APPROVAL_REJECTED`, `APPROVAL_EXPIRED`, `APPROVAL_CONSUMED`, `APPROVAL_INPUT_MISMATCH`, `APPROVAL_SELF_APPROVAL`, plus anything stages 9–15 produce.

---

## `runtime.approvals`

The configured `ApprovalCoordinator`, exposed for the application's approval UI/API:

```ts
interface ApprovalCoordinator {
  create(request: ApprovalRequest): Promise<ApprovalRecord>;
  get(id: string): Promise<ApprovalRecord | null>;
  decide(id: string, decision: ApprovalDecision): Promise<ApprovalRecord>;  // throws unless pending & unexpired
  markConsumed(id: string, executionId: string): Promise<ApprovalRecord>;   // atomic; throws if already consumed
  list?(filter?: { status?: ApprovalStatus; capabilityId?: string; actorId?: string }): Promise<ApprovalRecord[]>;
}

type ApprovalRequest = {
  id: string;
  capabilityId: string;
  surface: ExposureSurface;
  actor: Actor;                       // requester
  input: unknown;                     // validated input (stored for resumption)
  inputHash: string;                  // sha256 of canonical JSON
  reasons: string[];                  // merged from policies / static meta
  types: string[];                    // merged approvalTypes
  risk: RiskLevel;
  sideEffect: SideEffect;
  requestedAt: Date;
  expiresAt: Date;
};

type ApprovalDecision = {
  status: "approved" | "rejected";
  approver: Actor;
  comment?: string;
};

type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "cancelled" | "consumed";

type ApprovalRecord = ApprovalRequest & {
  status: ApprovalStatus;
  decision?: ApprovalDecision & { decidedAt: Date };
  consumedByExecutionId?: string;
};
```

`decide` emits `capability.approved` / `capability.rejected`. Deciding does not execute anything — the application (or its worker) must call `runtime.resume` afterward: approving and executing are distinct acts, by design.

### `createInMemoryApprovalCoordinator`

```ts
function createInMemoryApprovalCoordinator(options?: { now?: () => Date }): ApprovalCoordinator;
```

Process-local `Map`-backed coordinator for development and tests. **Records do not survive restarts** — production deployments implement `ApprovalCoordinator` over their own storage ([ADR-007](../architecture/decisions.md#adr-007-durable-execution-is-adapter-based), [guides/human-approval.md](../guides/human-approval.md)).

---

## Tracing interface

```ts
interface TracingAdapter {
  startSpan(name: string, attributes: SpanAttributes, parent?: SpanHandle): SpanHandle;
}
interface SpanHandle {
  setAttributes(attributes: SpanAttributes): void;
  recordError(error: unknown): void;
  end(status: "ok" | "error"): void;
}
type SpanAttributes = Record<string, string | number | boolean>;
```

Core calls this neutral interface; `@orpc-agent/opentelemetry` implements it. Span names and attribute conventions: [events.md](events.md#trace-spans). Without a `tracing` adapter configured, span calls are no-ops.

---

## Concurrency and state

The runtime object is stateless per invocation (all mutable state lives in the coordinator and sinks) and safe for concurrent `invoke` calls. Two runtimes over one registry are independent — useful for per-deployment policy sets.
