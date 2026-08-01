# Reference: capability metadata

Package: `@orpc-agent/core`. The `AgentMeta` object is the declaration that turns an oRPC procedure into a capability. It lives in the procedure's ordinary oRPC metadata under the `agent` key and is validated when `createCapabilityRegistry` builds the registry.

## Type

```ts
type AgentMeta = {
  /** Model-facing explanation of what the capability does and when to use it. Required. */
  description: string;

  /** Deny-by-default exposure per surface. Only `true` exposes. Required. */
  expose: Partial<Record<ExposureSurface, boolean>>;

  /** What the capability does to the world. Required. Never inferred. */
  sideEffect: "none" | "read" | "write" | "destructive" | "external";

  /** Sensitivity of the operation, independent of sideEffect. Required. Never inferred. */
  risk: "low" | "medium" | "high" | "critical";

  /** Free-form labels for filtering and policy targeting. */
  tags?: string[];

  /** Per-capability execution timeout. Default: runtime `defaults.timeoutMs` (30 000). */
  timeoutMs?: number;

  /** Runtime-managed retries. Only effective under the eligibility rules (SI-11). */
  retry?: {
    maxAttempts: number;                       // additional attempts after the first
    backoffMs?: number;                        // base delay, exponential; default 250
    retryOn?: (error: CapabilityError) => boolean; // extra predicate over `retryable` errors
  };

  /** Declares that repeating the operation with the same input is safe.
      Required (with retry config) before the runtime will retry a write. */
  idempotent?: boolean;

  /** Static approval gate. Conditional approval belongs in policies. */
  approval?: {
    required?: boolean;
    type?: string;            // e.g. "manager", "human-confirmation"
    expiresInMs?: number;     // default: runtime defaults.approvalExpiresInMs (900 000)
  };

  /** Redaction hooks. Applied per the pipeline (stages 8 and 13). */
  redact?: {
    /** Maps validated output to its model-safe form before adapter serialization. */
    output?: (output: unknown) => unknown;
    /** Maps validated input to what approval UIs may display. */
    approvalInput?: (input: unknown) => unknown;
  };

  /** Capability-scoped policies, evaluated after runtime-level policies. */
  policies?: AgentPolicy[];

  /** Adapter-specific overrides. Never affects governance. */
  adapters?: {
    aiSdk?: { toolName?: string };
    mcp?: { toolName?: string; annotations?: Record<string, unknown> };
  };
};
```

```ts
type ExposureSurface = "direct" | "aiSdk" | "mcp" | "workflow" | "test";
```

## Field semantics

### `description` (required)

Written for the model: state what the capability does, when to use it, and any preconditions ("Search orders by customer email. Use after resolving the customer id."). This is prompt real estate — keep it under ~300 characters. Not a place for security notes; models don't enforce them.

### `expose` (required)

The exposure map is the whole of SI-1. Absent surface = not exposed. `expose: {}` is valid and means "capability defined, reachable nowhere" (useful while staging a rollout). The registry does not reject it but `inspect()` flags it.

Exposure governs only the **agent runtime path**. The same procedure mounted in a normal oRPC router keeps serving your app's HTTP/RPC traffic regardless of `expose` — oRPC Agent adds a path, it never blocks existing ones.

### `sideEffect` (required)

| Value | Meaning | Default consequences |
|---|---|---|
| `none` | Pure computation | Retry-eligible |
| `read` | Reads application state | Retry-eligible |
| `write` | Creates/updates state | Never auto-retried unless `idempotent: true` + explicit `retry` |
| `destructive` | Deletes or irreversibly changes state | Never auto-retried without explicit config; expect approval policies to target it |
| `external` | Leaves the system (email, payment, third-party API) | Treated like `write` for retries; expect approval/confirmation policies |

### `risk` (required)

Independent of `sideEffect` — a read of salary data is `read`/`high`. Risk drives nothing automatically; it exists so policies, approval routing, and audit filters have a stable, reviewed classification to target (`req.capability.meta.risk === "critical"`). Requiring it forces the classification conversation at definition time.

### `retry` + `idempotent`

Full rules in [security/idempotency-and-retries.md](../security/idempotency-and-retries.md). Summary: runtime retries wrap pipeline stage 11 only, fire only on `retryable` errors, and only for `none`/`read` side effects — unless the capability declares both `idempotent: true` and a `retry` config, which is an explicit, reviewable statement.

### `approval`

`approval.required: true` is the static form of `requireApproval()` — every invocation gates. Use policies for conditional gates (amount thresholds, role exceptions). Both routes converge in pipeline stage 8 and produce identical `ApprovalRequest`s.

### `redact`

`redact.output` runs after output validation, before anything leaves the runtime (adapter results and any opt-in trace/audit payload). `redact.approvalInput` shapes what approval UIs render; the *hash* still binds the full validated input. Redaction functions must be pure and total (throwing fails the execution with `EXECUTION_FAILED`).

### `adapters`

Cosmetic/protocol hints only (tool naming, MCP annotations). Nothing here may change governance behavior — enforced by review, stated by design.

## Declaring metadata

```ts
import { os } from "@orpc/server";
import { agentProcedure } from "@orpc-agent/core";
import * as z from "zod";

const base = os.$context<AppContext>();
const agentBase = agentProcedure(base);

export const searchOrders = agentBase
  .meta({
    agent: {
      description: "Search orders by customer email or order number.",
      expose: { aiSdk: true, mcp: true, direct: true },
      sideEffect: "read",
      risk: "low",
      tags: ["orders"],
    },
  })
  .input(z.object({ query: z.string().min(2), limit: z.number().int().max(50).default(10) }))
  .output(z.object({ orders: z.array(OrderSummary) }))
  .handler(async ({ input, context, signal }) => {
    return { orders: await context.orders.search(input, { signal }) };
  });
```

## Validation at registry build

`createCapabilityRegistry` validates every included procedure's metadata and throws a single aggregate error listing all problems:

- missing `description`, `expose`, `sideEffect`, or `risk`;
- unknown surface keys in `expose`;
- `retry` on `write`/`destructive`/`external` without `idempotent: true`;
- adapter `toolName` collisions after name mapping;
- `timeoutMs`/`expiresInMs` non-positive.

Fail-fast at startup, never at first invocation.

## Related

- Concepts: [capabilities](../concepts/capabilities.md) · Guides: [defining capabilities](../guides/defining-capabilities.md), [capability exposure](../guides/capability-exposure.md)
