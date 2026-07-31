# Reference: configuration

> **Status:** Stable — 1.0.

Single page for every knob, its default, and where it applies. Precedence for overlapping settings: **call site > capability meta > runtime defaults**.

## Runtime (`createAgentRuntime`)

| Option | Type | Default | Notes |
|---|---|---|---|
| `governance` | `AgentGovernance` | — (required) | The governed surface as one declared value: [`defineGovernance({ registry, policies })`](core.md#definegovernance). The only accepted form — there is no `registry`/`policies` pair ([ADR-016](../architecture/decisions.md#adr-016-runtime-policies-are-part-of-the-governance-contract)). Runtime-level policies evaluate in order, before per-capability `meta.policies` |
| `approvals.coordinator` | `ApprovalCoordinator` | in-memory | Dev/test default; production supplies a persistent impl (`@orpc-agent/postgres` provides the reference) |
| `approvals.handler` | `(req) => Promise<ApprovalDecision \| undefined>` | — | Inline mode; deciding requests never suspend; returning `undefined` defers that request to the coordinator flow (ADR-006 addendum) |
| `approvals.rejectSelfApproval` | `boolean` | `true` | SI-4; disable only with a documented reason |
| `audit` | sink \| sink[] \| `{ sinks, strict, verbose, onSinkError }` | none | No sink = no audit persistence (`@orpc-agent/postgres` provides the reference sink) |
| `audit.strict` | `boolean` | `false` | Await `capability.started` before execution; fail with `AUDIT_UNAVAILABLE` |
| `audit.verbose` | `boolean` | `false` | Adds catalog-sized payloads — today, `capabilityIds` on `capabilities.discovered` |
| `tracing` | `TracingAdapter` | no-op | `@orpc-agent/opentelemetry` provides one |
| `defaults.timeoutMs` | `number` | `30_000` | Per-execution ceiling; capability `timeoutMs` overrides |
| `defaults.policyTimeoutMs` | `number` | `5_000` | Per policy-evaluation batch; exceeding ⇒ `POLICY_FAILED` (deny) |
| `defaults.policyConcurrency` | `number` | `16` | Capabilities whose discovery-phase policy batches evaluate at once; within one capability, order and the shared batch deadline are unchanged |
| `defaults.discoveryBudgetMs` | `number` | `30_000` | Ceiling on a whole `describe`, not one batch; expiry throws `TIMEOUT` @ `discovery` rather than returning a short catalog |
| `defaults.approvalExpiresInMs` | `number` | `900_000` | Overridable per capability (`meta.approval.expiresInMs`) and per decision (`requireApproval({ expiresInMs })`). 15 min suits present-human confirmation; raise it for dashboard-latency approvals or requests expire before anyone sees them |
| `now` | `() => Date` | system clock | Injected for deterministic tests |

**There is no `warnings` flag.** Startup footgun warnings — approval-gated capabilities on the restart-amnesiac default coordinator, write-capable capabilities on model surfaces with no audit sink — are never fatal and cannot be muted. Each fires only where a decision was left *implicit*, and each is answered by making it: name `approvals.coordinator` (`createInMemoryApprovalCoordinator()` is a legitimate answer) or name an `audit` sink (`audit: () => {}` states deliberately that nothing is recorded). A mute switch would be a second way to say what a configuration choice already says, and a worse one — global, outliving its reason, invisible to review ([ADR-016 §9](../architecture/decisions.md#adr-016-runtime-policies-are-part-of-the-governance-contract)).

## Capability meta (summary; full page: [metadata.md](metadata.md))

| Field | Default | Governs |
|---|---|---|
| `description` | — (required) | Model-facing usage text; the adapters' tool description |
| `expose` | — (required; absent surface = denied) | SI-1 |
| `sideEffect`, `risk` | — (required) | Policy targeting, retry eligibility |
| `tags` | `[]` | Policy targeting, and what `describe`'s `scope.tags` matches (untagged matches no `tags` scope) |
| `timeoutMs` | runtime default | Stage 10 |
| `retry.maxAttempts` | `0` | Stage 11 retries (eligibility per SI-11) |
| `retry.backoffMs` | `250` | Exponential base |
| `idempotent` | `false` | Write-retry eligibility |
| `approval.required` | `false` | Static stage-8 gate |
| `approval.type` | none | Merged into the approval request's `types` |
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
| `scope` (`describe` only) | none | `{ tags?, ids? }` — narrows *before* discovery policies run; discovery shaping, never authorization (SI-2) |
| `surface` | `"direct"` | Adapters hardcode theirs |
| `signal` | none | Composed with timeout at stage 10 |
| `correlationId` | none | Threads run/conversation ids through events and spans |

## Adapter options

**`toAISDKTools(runtime, options)`** — [adapters/ai-sdk.md](../adapters/ai-sdk.md)

| Option | Default | |
|---|---|---|
| `actor`, `context` | — (required) | Bound per tool set (build per request) |
| `scope` | none | Forwarded to `describe`: decides what gets *discovered*. Not authorization (SI-2) |
| `filter` | none | UX narrowing applied after discovery, not authorization (SI-2) |
| `toolNaming` | `.`→`_` | Collision ⇒ startup error |
| `signal` | none | Composed into every invocation, alongside the loop's per-call abort |

**`createMCPServer(runtime, options)`** — [adapters/mcp.md](../adapters/mcp.md)

| Option | Default | |
|---|---|---|
| `createContext` | — (required) | Session → `{ actor, context }`; refusing the session is the only anonymous default |
| `serverInfo` | `{ name: "orpc-agent", version: pkg }` | |
| `filter`, `toolNaming` | as above | |

No `scope` here: it is an AI SDK option only, because that adapter's caller composes per request while `tools/list` is protocol-driven ([Q12](../open-questions.md#q12)).

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
| `registry` | — (required) | Takes a registry and policies directly, unlike `createAgentRuntime` — a test runtime builds the governance for you |
| `policies` | `[]` | |
| `approvals` | `approvalProbe()` | Or `"auto-approve"` / `"auto-reject"`, or a custom coordinator |
| `actor` | `fakeActor()` | Per-call override allowed |
| `context` | `{}` | Per-call override allowed |
| `overrides` | `{}` | `Record<capabilityId, handler>` — stub procedure handlers |
| `clock` | `testClock()` | Drives `now`, expirations |
| `tracing` | no-op | For adapter conformance suites that assert on spans |

## Environment

Nothing is read from environment variables. All configuration is explicit code — deliberate: governance settings should be reviewable in source control.
