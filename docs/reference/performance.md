# Reference: cost and performance

> What governance costs, measured rather than asserted, and which knobs move it.

Short version: **the per-invocation overhead is tens of microseconds** and is dominated by schema validation, not by policy machinery. It disappears against any handler that touches a database. Discovery is the part that scales with catalog size, and it is the part with knobs.

## Install footprint

Published tarballs, and what each pulls in:

| Package | Packed | Unpacked | Runtime dependencies |
|---|---|---|---|
| `@orpc-agent/core` | 63 kB | 252 kB | `@standard-schema/spec` (types). Peers: `@orpc/server`, `zod` (optional) |
| `@orpc-agent/ai-sdk` | 5 kB | 16 kB | core. Peer: `ai` |
| `@orpc-agent/mcp` | 7 kB | 22 kB | core. Peer: `@modelcontextprotocol/sdk` |
| `@orpc-agent/postgres` | 10 kB | 38 kB | core. **No database driver** |
| `@orpc-agent/opentelemetry` | 3 kB | 9 kB | core. Peer: `@opentelemetry/api` |
| `@orpc-agent/testing` | 9 kB | 36 kB | core. Peer: `@orpc/server` |
| `@orpc-agent/cli` | 59 kB | 214 kB | Peer: core. Ink/React are `optionalDependencies` |

Core's JavaScript is 66 kB unminified, and its only production dependency is a types package. Every protocol SDK is a peer, so you control the version and pay for nothing you do not use ([ADR-003](../architecture/decisions.md#adr-003-core-is-provider-neutral)). Installing with `--no-optional` keeps the CLI to itself plus core; only `orpc-agent init` needs the renderer.

Nothing is server-side only by accident: core uses Web Crypto for hashing and `AbortSignal` for bounds, both platform built-ins.

## Per-invocation overhead

Measured against a trivial handler, so the numbers are *all* overhead — a real handler's own work is added on top and normally dwarfs it.

| | ms/op |
|---|---|
| `call(procedure, …)` — oRPC directly, no governance | 0.004 |
| `runtime.invoke` — no policies, no audit | 0.070 |
| `runtime.invoke` — 3 policies | 0.068 |
| `runtime.invoke` — 3 policies + an audit sink | 0.071 |

**Governance costs roughly 65 µs per invocation**, and three policies plus an audit sink cost nothing measurable on top. That shape is the point: policies are deterministic synchronous functions, and audit emission is off the critical path by default. The fixed cost is the pipeline itself — the execution id, the runtime-side schema validation at stage 5, the result envelope, the span calls.

For scale: 65 µs is well under a millisecond, while one round trip to a database in the same process is typically 0.5–5 ms and a model call is hundreds of milliseconds. If an agent-facing endpoint is slow, the pipeline is not why.

Two things genuinely can cost, and both are yours:

- **A policy that awaits I/O** adds its full latency to every invocation it applies to. Precompute into context, or move the check into middleware where it already runs.
- **`audit: { strict: true }`** awaits the `capability.started` write before executing, so your sink's write latency lands in every invocation. That is the trade you are buying: no record, no execution ([T12](../security/threat-model.md)).

Runtime-managed retries multiply only the handler, not the pipeline — the retry loop wraps stage 11 alone.

## Discovery, and why it has knobs

`describe` walks the registry, filters by exposure, evaluates discovery-phase policies, converts schemas, and emits one audit event. With a synchronous discovery policy:

| Catalog | ms/op |
|---|---|
| 10 capabilities | 0.18 |
| 100 capabilities | 1.56 |
| 300 capabilities | 3.03 |

Linear, and small in absolute terms — but this runs **per tool-set build**, and the per-actor composition rule means once per request, often once per step of every turn. At 300 capabilities and eight steps a turn, that is ~24 ms of pure discovery per turn, per concurrent user, to build catalogs the model mostly ignores.

`scope` is the fix, because it filters **before any discovery policy runs**:

| At 300 capabilities | ms/op |
|---|---|
| Full catalog | 3.07 |
| `scope: { tags: ["devices"] }` → 50 capabilities | 0.62 |

Five times cheaper for a sixth of the catalog, and the saving is the *work*, not just the tokens — the discarded capabilities' policies never evaluate and their schemas are never cloned ([ADR-017](../architecture/decisions.md#adr-017-discovery-takes-a-scope-and-a-budget)).

The adapter's `filter` does not do this. It runs on descriptors that already came back, so it trims what the model sees while you pay full price: **`scope` decides what gets discovered; `filter` decides what survives discovery.**

### The multiplier that actually hurts

A discovery-phase policy runs **once per candidate capability**, not once per call. An invocation policy doing a permission lookup costs one round trip; the same policy at discovery phase costs one per capability. At 300 capabilities with a 20 ms lookup, that is 6 seconds of discovery — per step.

The runtime bounds the damage rather than hiding it:

- `defaults.policyConcurrency` (16) evaluates that many capabilities' policy batches at once, so the wall-clock cost is the serial cost divided by 16, not multiplied by 300.
- `defaults.discoveryBudgetMs` (30 s) caps the whole walk and **throws** `TIMEOUT` at `stage: "discovery"` rather than returning a short catalog, because a silently truncated list is indistinguishable from "this actor lost access".

Neither makes the lookups free. [Keep discovery policies synchronous or memoized](../concepts/policies.md#keep-discovery-phase-policies-synchronous-or-memoized) — that is the real fix; the bounds are a backstop.

## Startup

`createCapabilityRegistry` validates every capability's metadata, checks tool-name collisions, and verifies that schemas exposed to `aiSdk`/`mcp` convert to JSON Schema. One-off, at boot:

| Catalog | ms |
|---|---|
| 10 capabilities | 0.8 |
| 100 capabilities | 4.9 |
| 300 capabilities | 10.6 |

`createAgentRuntime` is pure and synchronous on top of that — it wires configuration and returns, with no I/O. Schema conversions memoize per schema object, so the first `describe` does not re-pay this.

## Memory and concurrency

The runtime is stateless per invocation and safe for concurrent `invoke` calls; all mutable state lives in the coordinator and your sinks. Two runtimes over one governance are independent and share the underlying registry by reference, so building a second one for a different approval mode costs essentially nothing.

Audit events are constant-size by default. `capabilities.discovered` carries `{ count, surface, digest }` rather than the id list precisely because it fires on every discovery — at 300 capabilities the array was ~6 KB emitted per step, per turn, per concurrent user. `audit: { verbose: true }` restores it if you need the ids and have somewhere bounded to put them.

## What to measure in your own app

These numbers are the framework's floor, taken on one machine. What varies in practice is entirely yours:

1. **Policy latency.** Log the `agent.policy_evaluation` span. Anything above a millisecond is doing I/O it should not.
2. **Discovery frequency.** Count `capabilities.discovered` events per turn. If it is more than one per step, something is re-composing needlessly.
3. **Sink latency**, if you run strict mode — it is on the critical path there and nowhere else.
4. **Handler time.** `capability.completed` carries `durationMs`, which is the handler plus the middleware chain. It is almost always the number that matters.

## Measurement conditions

Node 24, Apple M1, single process, trivial handlers, 20 000 iterations for invocation timings and 300 for discovery, after warm-up. Relative differences travel across machines; absolute figures will not. Reproduce with your own capabilities before planning around them.

## Related

- [Concepts: policies](../concepts/policies.md#keep-discovery-phase-policies-synchronous-or-memoized) · [Reference: runtime](runtime.md#scope-discovery-shaping-never-an-authority-boundary) · [Reference: configuration](configuration.md)
