# Reference: configuration

> **Status:** Stable — 1.0.

Single page for every knob, its default, and where it applies. Precedence for overlapping settings: **call site > capability meta > runtime defaults**.

## Runtime (`createAgentRuntime`)

| Option | Type | Default | Notes |
|---|---|---|---|
| `registry` | `CapabilityRegistry` | — (required) | |
| `policies` | `AgentPolicy[]` | `[]` | Evaluated in order, before per-capability `meta.policies` |
| `approvals.coordinator` | `ApprovalCoordinator` | in-memory | Dev/test default; production supplies a persistent impl (`@orpc-agent/postgres` provides the reference) |
| `approvals.handler` | `(req) => Promise<ApprovalDecision \| undefined>` | — | Inline mode; deciding requests never suspend; returning `undefined` defers that request to the coordinator flow (ADR-006 addendum) |
| `approvals.rejectSelfApproval` | `boolean` | `true` | SI-4; disable only with a documented reason |
| `audit` | sink \| sink[] \| `{ sinks, strict, onSinkError }` | none | No sink = no audit persistence (`@orpc-agent/postgres` provides the reference sink) |
| `audit.strict` | `boolean` | `false` | Await `capability.started` before execution; fail with `AUDIT_UNAVAILABLE` |
| `tracing` | `TracingAdapter` | no-op | `@orpc-agent/opentelemetry` provides one |
| `defaults.timeoutMs` | `number` | `30_000` | Per-execution ceiling; capability `timeoutMs` overrides |
| `defaults.policyTimeoutMs` | `number` | `5_000` | Per policy-evaluation batch; exceeding ⇒ `POLICY_FAILED` (deny) |
| `defaults.approvalExpiresInMs` | `number` | `900_000` | Overridable per capability (`meta.approval.expiresInMs`) and per decision (`requireApproval({ expiresInMs })`). 15 min suits present-human confirmation; raise it for dashboard-latency approvals or requests expire before anyone sees them |
| `now` | `() => Date` | system clock | Injected for deterministic tests |
| `warnings` | `boolean` | `true` | Startup footgun warnings (never fatal): approval-gated capabilities on the default in-memory coordinator (unless an inline handler is configured), and write-capable capabilities exposed to `aiSdk`/`mcp` with no audit sink |

## Capability meta (summary; full page: [metadata.md](metadata.md))

| Field | Default | Governs |
|---|---|---|
| `expose` | — (required; absent surface = denied) | SI-1 |
| `sideEffect`, `risk` | — (required) | Policy targeting, retry eligibility |
| `timeoutMs` | runtime default | Stage 10 |
| `retry.maxAttempts` | `0` | Stage 11 retries (eligibility per SI-11) |
| `retry.backoffMs` | `250` | Exponential base |
| `idempotent` | `false` | Write-retry eligibility |
| `approval.required` | `false` | Static stage-8 gate |
| `approval.expiresInMs` | runtime default | |
| `redact.output` | identity | Stage 13 |
| `redact.approvalInput` | identity | Approval UI display |
| `policies` | `[]` | After runtime-level policies |
| `adapters.*.toolName` | id with `.`→`_` | Naming only |

## Invocation options (`invoke` / `describe` / `resume`)

| Option | Default | Notes |
|---|---|---|
| `actor` | — (required) | Authenticated identity; never model-derived (SI-3) |
| `context` | — (required) | The app's oRPC context |
| `surface` | `"direct"` | Adapters hardcode theirs |
| `signal` | none | Composed with timeout at stage 10 |
| `correlationId` | none | Threads run/conversation ids through events and spans |

## Adapter options

**`toAISDKTools(runtime, options)`** — [adapters/ai-sdk.md](../adapters/ai-sdk.md)

| Option | Default | |
|---|---|---|
| `actor`, `context` | — (required) | Bound per tool set (build per request) |
| `filter` | none | UX narrowing, not authorization (SI-2) |
| `toolNaming` | `.`→`_` | Collision ⇒ startup error |

**`createMCPServer(runtime, options)`** — [adapters/mcp.md](../adapters/mcp.md)

| Option | Default | |
|---|---|---|
| `createContext` | — (required) | Session → `{ actor, context }` |
| `serverInfo` | `{ name: "orpc-agent", version: pkg }` | |
| `filter`, `toolNaming` | as above | |

**`createOpenTelemetryTracing(options?)`** — [adapters/opentelemetry.md](../adapters/opentelemetry.md)

| Option | Default | |
|---|---|---|
| `tracer` | `trace.getTracer("orpc-agent")` | |
| `actorIdAttribute` | `false` | Off by default (SI-10-adjacent) |

**`createPgApprovalCoordinator(options)` / `createPgAuditSink(options)`** — [adapters/postgres.md](../adapters/postgres.md)

| Option | Default | |
|---|---|---|
| `query` | — (required) | `(sql, params) => Promise<{ rows }>` — the driver seam (ADR-013) |
| `table` | `orpc_agent_approvals` / `orpc_agent_audit_events` | Validated identifier, optionally schema-qualified |
| `now` (coordinator) | system clock | Drives every expiry comparison |
| `batch` (sink) | none | `{ size?: 50, flushMs?: 250 }`; `capability.started` always writes through awaited |

**`createAgentTestRuntime(options)`** — [adapters/testing.md](../adapters/testing.md)

| Option | Default | |
|---|---|---|
| `registry` | — (required) | |
| `policies` | `[]` | |
| `approvals` | `approvalProbe()` | Or `"auto-approve"` / `"auto-reject"` |
| `actor` | `fakeActor()` | Per-call override allowed |
| `context` | `{}` | Per-call override allowed |
| `overrides` | `{}` | `Record<capabilityId, handler>` — stub procedure handlers |
| `clock` | `testClock()` | Drives `now`, expirations |

## Environment

Nothing is read from environment variables. All configuration is explicit code — deliberate: governance settings should be reviewable in source control.
