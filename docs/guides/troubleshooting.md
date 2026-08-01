# Guide: troubleshooting

> Indexed by what you saw. For the closed contract behind each code, see [reference/errors](../reference/errors.md).

## Startup fails before serving a request

`createCapabilityRegistry` validates the whole tree and throws **one** aggregate error listing every problem — deliberately, so you fix them in one pass rather than one restart at a time:

```
Capability registry validation failed (3 problems):
  - "orders.refund": missing required "risk" (one of low, medium, high, critical)
  - "orders.void": "retry" requires "idempotent: true" for write side effects
  - tool name collision on surface "aiSdk": "orders.get" and "orders.fetch" both map to "orders_get"
```

| Message contains | Cause | Fix |
|---|---|---|
| `missing required "description" / "expose" / "sideEffect" / "risk"` | The four required `agent` fields are not inferred — ever | Declare them. [metadata](../reference/metadata.md#field-semantics) |
| `"retry" requires "idempotent: true"` | Retry config on a `write`/`destructive`/`external` capability | Either declare `idempotent: true` — a reviewable claim that repeating with identical input is safe — or drop the retry config (SI-11) |
| `tool name collision on surface "aiSdk"` | Two capabilities map to the same wire name after `.`→`_` | Rename a path, or set `meta.adapters.aiSdk.toolName` on one. Never silently renamed |
| `input schema cannot be converted to JSON Schema` | The capability is exposed to `aiSdk`/`mcp`, which need JSON Schema | See the next row, or narrow `expose` |
| `No JSON Schema converter registered for schema vendor "…"` | Non-Zod schema library | `registerSchemaConverter(vendor, convert)` once at startup ([core/schema](../reference/core.md#schema-utilities)) |
| `The built-in Zod converter requires Zod v4` | Zod 3 installed | Upgrade, or register your own converter for vendor `"zod"` |
| `event-iterator (streaming) procedures cannot be capabilities` | The procedure returns an event iterator | Streaming has no governance semantics yet ([Q11](../open-questions.md#q11)). Split out a non-streaming procedure for the agent path |
| `lazy routers/procedures are not supported` | A lazy router was passed to the registry | `unlazyRouter(...)` first — registry construction is synchronous |
| `value is not an oRPC procedure or a nested record` | A non-procedure leaked into the defs object | Registries take procedures and nested plain objects, nothing else |

**A procedure vanished instead of erroring.** Procedures without `meta.agent` are excluded silently by design — that is deny-by-default (SI-1) working. `capabilities.inspect().excluded` lists every one with its reason; log it at boot, and the "nothing leaked" review surface becomes visible.

## Startup warns but keeps going

Two warnings fire, and neither can be muted — each marks a decision left implicit, and each is answered by making it explicit:

| Warning | Answer |
|---|---|
| Approval-gated capabilities with the default in-memory coordinator | Name `approvals.coordinator`. `createInMemoryApprovalCoordinator()` is a legitimate answer for dev; `@orpc-agent/postgres` is the reference for production |
| Write-capable capabilities on a model surface with no audit sink | Name an `audit` sink. `audit: () => {}` states deliberately that nothing is recorded |

## The model gets an error

`invoke` never throws for governed outcomes, so what you are looking at is a `failed` or `cancelled` envelope. The `stage` field tells you which guarantee refused, without reading a stack trace.

### `CAPABILITY_NOT_FOUND`

Three different truths present identically to a client, by design (SI-8): the id does not exist, it is not exposed on this surface, or a policy returned `hide()`. **Your audit trail records which** — `capability.denied` carries `data.reason` as `unknown`, `not-exposed`, or `hidden`.

```ts
const denied = t.audit.ofType("capability.denied").at(-1);
denied.data.reason;   // "not-exposed" → the expose map, not a policy
```

Most common cause: the capability is exposed to `aiSdk` but you invoked with `surface: "direct"` (the default), or vice versa. Exposure is per surface and `true` is the only value that grants it.

### `INPUT_INVALID`

The model produced arguments your schema rejected. `error.details` carries issue paths and messages — this is the one case where structured detail crosses to the model, because the model authored the data and can self-correct next step.

If it recurs for the *same* field, the fix is usually the description, not the schema: say what the field expects.

### `POLICY_DENIED` you did not expect

Every policy's stance is recorded, so you never have to guess which one fired:

```ts
result.error.code;                                 // "POLICY_DENIED"
t.audit.ofType("capability.denied").at(-1).data.policyDecisions;
// [{ policy: "org-isolation", type: "allow" }, { policy: "mcp-read-only", type: "deny" }]
```

Remember precedence: `deny` > `hide` > `require-approval` > `allow`, and **all** policies evaluate — there is no short-circuit, so the list is complete.

### `POLICY_FAILED`

A policy threw or exceeded `defaults.policyTimeoutMs`. This fails closed and denies (SI-7) — safe, but it means one of your policies is broken. The stance list marks it `type: "error"`. Alert on this code specifically; it is the one denial that indicates *your* bug rather than a governed refusal.

### `EXECUTION_FAILED` with a generic message

`"The operation failed."` with `exposeToModel: false` means your handler threw something it never declared. That is the design (SI-9): declared errors are contract, undeclared throws are internals. The real error is intact in `error.cause`, in your logs and audit trail.

To make a failure model-visible, declare it: `.errors({ NOT_ELIGIBLE: { message: "…" } })`.

### `TIMEOUT` on a call that should be fast

The composite signal fired at `meta.timeoutMs ?? defaults.timeoutMs` (30 s). Before raising it, check the handler forwards `signal` to its downstream calls — a handler that ignores it turns bounded execution into bounded *reporting*, and the work keeps running after you get the error (SI-12).

### `AUDIT_UNAVAILABLE`

Only reachable with `audit: { strict: true }`, and it means exactly what it says: the `capability.started` write failed, so nothing executed. That is strict mode working ([T12](../security/threat-model.md)). Pair it with alerting on the sink rather than weakening the mode.

## Approvals

| Code | What happened | Usually means |
|---|---|---|
| `APPROVAL_PENDING` | `resume` before anyone decided | The resume worker is racing the approver |
| `APPROVAL_EXPIRED` | Decided too late, or never | The expiry does not match the surface. The 15-minute default assumes the approver is present; a dashboard checked twice a day needs hours ([`expiresInMs`](../reference/metadata.md#approval)) |
| `APPROVAL_CONSUMED` | Second `resume` of one approval | Working as intended — approvals are single-use. A new invocation needs a new approval, even with identical input |
| `APPROVAL_SELF_APPROVAL` | Approver id equals requester id | The decide endpoint is not distinguishing identities, or a demo has one person playing both roles (see the [Mastra example](../examples/mastra-task-board.md#self-approval-disabled-deliberately)) |
| `APPROVAL_INPUT_MISMATCH` | Stored input no longer hashes to its bound hash | **Investigate.** This is an integrity failure in the coordinator store, not a normal outcome (SI-5) |
| `APPROVAL_UNSERIALIZABLE_INPUT` | The validated input contains a function or symbol | The hash must bind everything that executes, so it refuses rather than silently dropping fields |

**A `Date` in the input breaks resume after a restart.** Persisted inputs round-trip through JSON, so a `z.date()` field revives as a string and fails re-validation. It fails *safe* — the approval is not consumed — but prefer `z.iso.datetime()` on approval-gated capabilities ([the round-trip caveat](../adapters/postgres.md#the-json-round-trip-caveat)).

**Approvals vanish on restart.** The default coordinator is in-memory. That is the warning above, in production form.

## A capability is missing from the model's tools

Work down the pipeline, in this order:

1. **Exposed?** `capabilities.get(id).meta.expose[surface] === true`. Anything else denies.
2. **In this registry?** A `filter()`ed registry makes it nonexistent for that runtime, not hidden.
3. **Scoped out?** A `scope` on `describe` (or on `toAISDKTools`) narrows before policies run — and **an untagged capability matches no `tags` scope**.
4. **Filtered out?** The adapter's `filter` runs after discovery.
5. **Hidden by a policy?** A discovery-phase policy returning `hide()` or `deny()` excludes it.

Only 1 and 5 are enforcement. Scope and filter are shaping — a capability left out of a listing is still fully invocable by an authorized actor (SI-2). If you need it *unreachable*, use exposure or a policy.

## `describe` throws

New in 2.0: it can reject with a `CapabilityError` (`code: "TIMEOUT"`, `stage: "discovery"`) when the whole discovery exceeds `defaults.discoveryBudgetMs` (30 s). It throws rather than returning a short catalog, because a silently truncated list is indistinguishable from "this actor lost access".

If you hit it, the cause is almost always a discovery-phase policy doing I/O — it runs **once per candidate capability**. [Make it synchronous, or narrow the walk with `scope`](../concepts/policies.md#keep-discovery-phase-policies-synchronous-or-memoized).

## The CLI

| Symptom | Cause |
|---|---|
| exit code `2` | The tool could not load your app — not "no drift". CI must treat 2 as failure, or the gate rots silently |
| `runtime policies not observed` | `--entry` resolved a bare registry. That is *unknown*, not *none*, and a snapshot taken this way cannot detect a runtime policy being deleted. Point `--entry` at a [`defineGovernance`](../reference/core.md#definegovernance) export |
| `inputSchemaHash: "unconvertible"` appearing everywhere | Two copies of `@orpc-agent/core` in the tree. `registerSchemaConverter` writes module-level state, so a duplicate makes your converter invisible. It reproduces with two *byte-identical* copies — check with `pnpm why @orpc-agent/core` |
| Drift you did not cause | Same as above, or a `--no-descriptions` flag differing between the snapshot and the check |
| `orpc-agent init` refuses | No TTY. It will not guess an entry and write an unreviewed governance config; run it interactively or set `orpcAgent` in `package.json` by hand |

## Still stuck

Reproduce it without a model — that is what [`@orpc-agent/testing`](../adapters/testing.md) is for. A failing six-line test that asserts the wrong envelope is a better bug report than a chat transcript, and it usually finds the answer before you file anything.
