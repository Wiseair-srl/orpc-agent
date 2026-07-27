# Reference: core

> **Status:** Proposed API — v0.1 design target. Stability: experimental unless noted.

Package: `@orpc-agent/core`. This page covers the definition-side API: `agentProcedure`, the registry, policies, decision helpers, and schema utilities. The execution-side API (`createAgentRuntime`, `invoke`, `describe`, `resume`, approvals) is in [runtime.md](runtime.md); errors in [errors.md](errors.md); events in [events.md](events.md).

---

## `agentProcedure`

```ts
function agentProcedure<B extends AnyORPCBuilder>(builder: B): AgentEnabledBuilder<B>;
```

**Purpose.** Types an oRPC builder for agent use: the meta type gains `{ agent?: AgentMeta }` and the context type gains `{ agent?: AgentInvocationInfo }`. It creates no wrapper object and changes no runtime behavior — the return value is the same oRPC builder, more precisely typed ([ADR-001](../architecture/decisions.md#adr-001-orpc-procedures-are-the-source-of-truth)).

**Parameters.** `builder` — any oRPC builder, typically your app base (`os.$context<AppContext>()` with shared middleware already applied).

**Returns.** The builder; `.meta({ agent: … })` is now type-checked against `AgentMeta`, and handlers/middleware can read `context.agent` (present only on agent-runtime invocations; `undefined` on plain HTTP/RPC calls — check before use).

**Errors.** None at runtime. The precise generic plumbing follows oRPC's builder generics and is pinned during implementation (Design target).

**Example.**

```ts
const base = os.$context<AppContext>().use(authMiddleware);
export const agentBase = agentProcedure(base);
```

---

## `createCapabilityRegistry`

```ts
function createCapabilityRegistry<T extends CapabilityDefs>(defs: T): CapabilityRegistry<T>;

type CapabilityDefs = { [segment: string]: AnyORPCProcedure | CapabilityDefs };
```

**Purpose.** Derives capabilities from a nested record of procedures (a plain object; an existing oRPC router object of procedures also fits the shape). Assigns each capability its stable id: the dot-joined path (`{ orders: { refund } }` → `"orders.refund"`).

**Behavior.**
- Procedures **with** `meta.agent`: validated (see [metadata.md](metadata.md#validation-at-registry-build)) and included.
- Procedures **without** `meta.agent`: excluded from every surface, listed by `inspect()` — inclusion is always an explicit act (SI-1), never an accident of router shape.
- Throws one aggregate error at build time listing every metadata problem.

**Returns.** `CapabilityRegistry`:

```ts
interface CapabilityRegistry {
  ids(): string[];
  get(id: string): AgentCapability | undefined;
  capabilities(): AgentCapability[];
  filter(query: CapabilityQuery | ((c: AgentCapability) => boolean)): CapabilityRegistry;
  inspect(): {
    capabilities: AgentCapability[];
    excluded: { path: string; reason: "no-agent-meta" }[];
    unexposed: string[];   // ids whose expose map enables no surface (staging state)
  };
}

type CapabilityQuery = {
  surface?: ExposureSurface;      // expose[surface] === true
  tags?: string[];                // any-of
  sideEffect?: SideEffect[];      // any-of
  risk?: RiskLevel[];             // any-of
};

interface AgentCapability {
  id: string;                     // "orders.refund"
  path: string[];                 // ["orders", "refund"]
  meta: AgentMeta;                // normalized (defaults resolved)
  inputSchema: StandardSchemaV1 | undefined;
  outputSchema: StandardSchemaV1 | undefined;
  procedure: AnyORPCProcedure;
}
```

`filter` returns a new registry (registries are immutable); use it to build narrowed runtimes for special deployments. Filtering is composition, not authorization (SI-2).

**Example.**

```ts
export const capabilities = createCapabilityRegistry({
  customers: { search: searchCustomers, get: getCustomer },
  orders: { search: searchOrders, refund: refundOrder },
});
capabilities.ids(); // ["customers.search", "customers.get", "orders.search", "orders.refund"]
```

---

## `definePolicy`

```ts
function definePolicy(
  name: string,
  evaluate: (req: PolicyRequest) => PolicyDecision | Promise<PolicyDecision>,
  options?: { phases?: PolicyPhase[] },   // default ["invocation"]
): AgentPolicy;
```

**Purpose.** Wraps a decision function with a stable name (used in audit events) and phase declaration. Full semantics — evaluation order, precedence, fail-closed, determinism expectations — in [concepts/policies.md](../concepts/policies.md).

```ts
type PolicyPhase = "discovery" | "invocation" | "execution";

type PolicyRequest = {
  phase: PolicyPhase;
  capability: { id: string; meta: AgentMeta };
  surface: ExposureSurface;
  actor: Actor;
  context: unknown;               // the app context, as passed to invoke/describe
  input?: unknown;                // validated input; undefined at discovery
  approval?: ApprovalRecord;      // present on resumed executions
};

type PolicyDecision =
  | { type: "allow"; metadata?: Record<string, unknown> }
  | { type: "deny"; code?: string; message?: string }
  | { type: "hide" }
  | { type: "require-approval"; reason: string; approvalType?: string; expiresInMs?: number };
```

**Lifecycle.** Runs at pipeline stage 7 (invocation), stage 9 (execution, opt-in), and during `describe` (discovery, opt-in via phases). Throw/timeout ⇒ deny (`POLICY_FAILED`, SI-7).

---

## `composePolicies`

```ts
function composePolicies(...policies: AgentPolicy[]): AgentPolicy;
```

Combines policies into one, preserving order and per-policy audit identity. Composition is associative; the combined decision follows the standard precedence (deny > hide > require-approval > allow). Exists for packaging reusable policy sets (`composePolicies(orgIsolation, businessHours)`); passing an array to `createAgentRuntime` is equivalent.

---

## Decision helpers

```ts
function allow(metadata?: Record<string, unknown>): PolicyDecision;
function deny(code?: string, message?: string): PolicyDecision;
function hide(): PolicyDecision;
function requireApproval(opts: { reason: string; approvalType?: string; expiresInMs?: number }): PolicyDecision;
```

Pure constructors for the four decision shapes. `deny`'s `message` becomes the public message of the resulting `POLICY_DENIED` error — write it for a model to read, leak nothing. `hide` outside the discovery phase acts as a concealing deny (SI-8).

**Example.**

```ts
export const refundLimit = definePolicy("refund-limit", ({ capability, input }) => {
  if (capability.id !== "orders.refund") return allow();
  const { amount } = input as { amount: number };
  return amount > 500
    ? requireApproval({ reason: `Refund of $${amount} exceeds the $500 limit`, approvalType: "manager" })
    : allow();
});
```

---

## `unwrap`

```ts
function unwrap<O>(result: ExecutionResult<O>): O;   // stability: experimental
```

Convenience for direct/workflow callers: returns `output` for `completed`, throws the contained `CapabilityError` for `failed`/`cancelled`, and throws a `CapabilityError` with code `APPROVAL_REQUIRED` (carrying the approval record in `details`) for `approval-required`. Adapters do not use it — they translate envelopes.

---

## Schema utilities — `@orpc-agent/core/schema`

```ts
function toJsonSchema(schema: StandardSchemaV1): JsonSchemaObject;
function registerSchemaConverter(
  vendor: string,                                   // StandardSchema `~standard.vendor`, e.g. "valibot"
  convert: (schema: StandardSchemaV1) => JsonSchemaObject,
): void;
```

**Purpose.** Adapters need JSON Schema for tool wire formats; Standard Schema does not standardize conversion ([ADR-009](../architecture/decisions.md#adr-009-standard-schema-interoperability-lives-in-core)). Built-in converter: Zod v4 (via `z.toJSONSchema`). Other vendors register a converter once at startup.

**Errors.** `toJsonSchema` throws for unknown vendors. The registry surfaces this at build time for capabilities exposed on schema-consuming surfaces (`aiSdk`, `mcp`) — startup failure, not first-call failure.

**Example (Valibot).**

```ts
import { registerSchemaConverter } from "@orpc-agent/core/schema";
import { toJsonSchema as valibotToJsonSchema } from "@valibot/to-json-schema";

registerSchemaConverter("valibot", (schema) => valibotToJsonSchema(schema as never));
```

---

## Supporting types

```ts
type Actor = {
  id: string;
  kind: "user" | "service" | "automation" | "anonymous";
  displayName?: string;
  attributes?: Record<string, unknown>;   // app-defined (roles, permissions, org)
};

type AgentInvocationInfo = {
  executionId: string;
  capabilityId: string;
  surface: ExposureSurface;
  actor: Actor;
  approval?: { id: string; approver: Actor };
  correlationId?: string;
  idempotencyKey: string;        // stable per execution (survives runtime retries)
};
```

`Actor` is the authenticated requesting entity — never the model (SI-3). `AgentInvocationInfo` is injected as `context.agent` at pipeline stage 11 so middleware and handlers can react to agent-originated calls.
