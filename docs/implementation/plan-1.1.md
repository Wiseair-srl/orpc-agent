# Implementation plan — v1.1 "Discovery at scale"

> **Status:** **Executed — released as 2.0.0, not 1.1.0.** N1–N4 implemented and landed as [ADR-017](../architecture/decisions.md#adr-017-discovery-takes-a-scope-and-a-budget); kept as the record of how the release was sequenced (like [plan-0.2](plan-0.2.md)). **The version is the plan's one substantive miss:** N2 removes a documented field from a documented audit event, and [the release process](../contributing/release-process.md) forbids a breaking change in a minor from 1.0 onward. The deprecation path it offers was rejected because the field to be deprecated is the unbounded array the increment exists to delete — see ADR-017's consequences. Three further deviations from the letter of the plan, all recorded below: `@orpc-agent/testing`'s `describe` forwards `scope` as well (the supported test seam had to be able to exercise the feature), and `defaults.discoveryBudgetMs` ships with a default of `30_000` rather than as an opt-in — a bound nobody sets bounds nothing. Driven by the second production consumer: a DPAS dashboard host (`create-dpas-app`) targeting ~300 capabilities across 6 tag groups, against the ~85-capability finance app that fixed 0.2's scope. Four increments, all in `@orpc-agent/core` and `@orpc-agent/ai-sdk`. N1 is the only structural change; the rest are bounded cleanups it makes worth doing.
>
> One sentence of the problem: **`describe()` has no way to return a subset**, so a host that wants a route-scoped catalog must fetch every capability the actor can see and discard most of it — paying full discovery cost, including every discovery-phase policy evaluation, on every step.

## Release definition

- **Version:** ~~1.1.0~~ **2.0.0**, all `@orpc-agent/*` packages (changesets `linked`). Planned as a minor; the audit payload change in N2 is breaking, and semver from 1.0 is strict.
- **Contents:** one additive API change (`describe` scope + adapter pass-through), one audit payload change, one concurrency change, no new packages.
- **Explicitly out of scope** (do not implement, even if adjacent): caching descriptors across requests (violates the per-actor composition rule and is the consumer's decision, not ours); scope as an authority boundary (see N1's invariant); pagination or cursors on `describe`; anything touching `invoke`; streaming; rate limits.

## Ground rules for the implementing agent

1. **Docs-first discipline.** N1's reference update ([reference/runtime.md](../reference/runtime.md), [concepts/capabilities.md](../concepts/capabilities.md)) merges in the same PR as the code, and lands as **ADR-017** in [architecture/decisions.md](../architecture/decisions.md) (next free number; 016 is the highest today).
2. **CI gates are the spec.** `pnpm build && pnpm test && pnpm typecheck && pnpm check:boundaries && pnpm check:api && pnpm check:capabilities && pnpm check:docs && pnpm docs:build` green at every increment. `check:api` compares exports against the `REQUIRED` map in `scripts/check-api-surface.mjs` — extend it for N1 and N4.
3. **SI-tagged tests are untouchable.** N1 in particular must not weaken SI-2: descriptors stay advisory, and `invoke` keeps re-checking everything regardless of what discovery returned.
4. **Conventions:** ESM-only, Node ≥ 20.19, TS strict, tsup, vitest, pnpm.
5. **One changeset per user-visible change**, past-tense, terse.

## Dependency graph

```
N1 (scope on describe)  ──┬──►  N4 (adapter pass-through)
                          └──►  consumer unblocked
N2 (bounded audit payload)   independent
N3 (policy concurrency)      independent, but N1 reduces the pressure it relieves
```

N2 and N3 can land in either order, before or after N1. Only N4 is blocked.

---

## N1 — `scope` on `describe()`, filtered before policy evaluation

**Problem.** `describePipeline` walks every capability in the registry, applies the exposure filter, and evaluates discovery-phase policies for each survivor. There is no parameter that narrows the walk. The only shaping available to a consumer is `filter` on `toAISDKTools`, which runs *after* `describe` returns:

```ts
const descriptors = await runtime.describe("aiSdk", { actor, context });
const filtered = options.filter ? descriptors.filter(options.filter) : descriptors;
```

That trims tokens and nothing else. Discovery cost — the registry walk, every discovery policy evaluation, a `structuredClone` of every input schema — is paid in full for capabilities the consumer is about to throw away. A host re-composing per step, per actor (as the composition rule requires) pays it on every step of every turn.

**Decision.** `describe` accepts an optional scope, applied immediately after the exposure filter and **before** any policy runs.

```ts
describe(
  surface: ExposureSurface,
  options: {
    actor: Actor;
    context: TContext;
    /**
     * Discovery shaping only, never an authority boundary (SI-2). Omit for
     * today's behavior. `tags` matches capabilities carrying ANY listed tag;
     * `ids` selects exactly. Both given: union.
     */
    scope?: { tags?: string[]; ids?: string[] };
  },
): Promise<CapabilityDescriptor[]>
```

**Scope matches on tags, because tags already exist.** `CapabilityMeta.tags?: string[]` is defined today, and `CapabilityDescriptor.tags: string[]` is already returned by `describePipeline`. Nothing new enters the metadata model: an application tags `devices.*` as `devices`, `billing.*` as `billing`, and a route asks for what it needs. No new concept to document, no migration for existing capabilities (untagged capabilities simply never match a `tags` scope — see the question in N1.4).

**In `describePipeline`, the ordering is normative:**

```
1. exposure filter (SI-1)          ← unchanged
2. scope filter                    ← NEW, cheap, no I/O
3. discovery-phase policies (SI-7) ← now runs only for the scoped subset
4. schema conversion + clone
5. capabilities.discovered audit
```

Placing scope at 2 rather than after 3 is the entire point. At step 3 it saves tokens; at step 2 it saves work.

**Invariant — scope is not authority.** `invoke` does not consult scope, in this or any later release. A capability outside the requested scope remains fully invocable by an authorized actor, exactly as adapter-level `filter` behaves today. A consumer that wants a capability unreachable must use exposure or a policy, and the reference docs must say so in the same paragraph that introduces the parameter. Test: invoke a capability excluded from the immediately preceding scoped `describe` and assert it succeeds.

**Compatibility.** Purely additive. Omitting `scope` returns today's result, byte for byte. Existing `filter` on the adapter is retained for post-hoc shaping.

**Tests.** Scope-narrows-result; scope-omitted-is-identity; **policy-evaluation-count** asserted directly (a counting policy proves filtering happens before evaluation — do not assert on timing); disjoint scope returns empty rather than everything; out-of-scope capability still invocable (the SI-2 case above).

---

## N2 — Bounded `capabilities.discovered` payload

**Problem.** Every discovery emits the complete id list:

```ts
deps.audit.emit({
  type: "capabilities.discovered",
  data: { capabilityIds: descriptors.map((d) => d.id) },
});
```

At 300 capabilities that is a ~6 KB array, emitted on every discovery — which for a per-step-composing host means every step of every turn of every concurrent user. Consumers that forward audit events to a client (the DPAS host streams them to a browser inspector panel) then carry the full list over the wire repeatedly, and any consumer whose forwarding is not actor-filtered turns it into a disclosure of one actor's authorized surface to another. That filtering is the consumer's bug to fix, but the payload size is ours: an unbounded array in a routine event invites it.

**Decision.** Emit constant-size data by default:

```ts
data: {
  count: descriptors.length,
  surface,
  /** Stable hash of the sorted id list. Equal digests ⇒ equal catalogs. */
  digest: string,
}
```

The full array moves behind an explicit verbose audit level (`audit: { verbose: true }`), off by default. A digest still answers the question the event exists to answer — *did this actor's visible catalog change, and when* — at constant size, and correlates across events without carrying the contents.

**Compatibility.** Breaking for any consumer reading `data.capabilityIds` from this event. Grep the examples and the CLI before landing; document in the changeset and in [reference/events.md](../reference/events.md).

---

## N3 — Concurrent discovery policies and a global batch budget

**Problem.** Two related sharp edges in `evaluatePolicies`, both latent rather than currently biting.

*Serial evaluation.* `describePipeline` awaits policies per capability in a `for` loop. Today's consumers write synchronous discovery policies — the DPAS host's `viewerHidesWrites` reads `session.role` off an already-resolved context, so 300 sequential awaits cost microseconds. The moment a consumer writes a discovery policy that does I/O (a permission lookup, a feature-flag read), that becomes 300 sequential round trips per discovery. Nothing in the docs warns against it, and the shape of the API invites it.

*Per-capability timeout budget.* `deadline` is computed per capability's policy batch, so `policyTimeoutMs` bounds one capability's policies, not the discovery. Worst case for a slow policy at 300 capabilities is 300 × `policyTimeoutMs` before `describe` returns.

**Decision.**

1. Evaluate discovery-phase policies with bounded concurrency (default 16, configurable via `defaults.policyConcurrency`). Fail-closed semantics are unchanged — a policy error still excludes its capability (SI-7) and never leaks into a neighbor's outcome.
2. Add `defaults.discoveryBudgetMs`, a global deadline across the whole discovery. On expiry, `describe` fails rather than returning a partial catalog: a silently short catalog is indistinguishable from "the actor lost access", which is precisely the confusion "authority hides" is meant to avoid.
3. Document in [concepts/policies.md](../concepts/policies.md): discovery-phase policies should be synchronous or memoized; if a lookup is unavoidable, batch it in context construction, not per capability.

**Tests.** Concurrency observed via an instrumented policy; per-capability failure isolation preserved; global budget expiry produces a typed error, never a truncated result.

---

## N4 — `scope` pass-through in `@orpc-agent/ai-sdk`

Blocked on N1. `AISDKToolsOptions` gains `scope?: { tags?: string[]; ids?: string[] }`, forwarded verbatim to `runtime.describe`. `filter` is unchanged and still applies after, so a consumer can scope cheaply and then shape precisely.

Doc note in [adapters/ai-sdk.md](../adapters/ai-sdk.md) distinguishing the two, since having both invites confusion: **`scope` decides what gets discovered; `filter` decides what survives discovery.** Neither is authorization. Extend the `REQUIRED` map in `scripts/check-api-surface.mjs`.

---

## Acceptance

1. `describe` with a scope covering 1 of 6 tag groups evaluates discovery policies for that group only — asserted by policy invocation count, not elapsed time.
2. `describe` without `scope` returns a result identical to 1.0.0 for the full example suite.
3. A capability excluded by scope remains invocable by an authorized actor (SI-2 holds).
4. `capabilities.discovered` payload size is constant in capability count at the default audit level.
5. A discovery policy that sleeps *n* ms across 300 capabilities completes in roughly `n × 300 / concurrency`, not `n × 300`.
6. Every SI-tagged test passes unchanged.

## Unresolved questions — as resolved

1. **Untagged capability vs a `tags` scope: none.** As leaned. Predictable, and it keeps scope opt-in: a scope returns what it names. Adopting scope before tagging returns nothing rather than everything, documented in [concepts/capabilities.md](../concepts/capabilities.md#tags-are-how-a-catalog-gets-asked-for-in-pieces) and the reference. `ids` reaches untagged capabilities.
2. **`scope.tags` is ANY.** As proposed; an intersection is expressible via `ids`.
3. **`digest` is explicitly opaque.** The contract is equality (equal digests ⇒ equal catalogs), not an algorithm. Committing to one would buy cross-version comparability nobody asked for and freeze an implementation detail of a routine event; the docs say compare, never parse or store as an identifier.
4. **No distinct error code.** `describe` throws `CapabilityError` with the existing `TIMEOUT` code at `stage: "discovery"`. A new code would extend a closed union every consumer switches on to say what `TIMEOUT` + `stage` already says. The policy-failure envelope was the wrong fit: `POLICY_FAILED` is non-retryable and concealed, while a blown budget is neither.
5. **`scope` does not reach `@orpc-agent/mcp` in 1.1.** `tools/list` is protocol-driven rather than composed per step, so the natural shape is server configuration, not a per-call argument — a different design question. Recorded as [Q12](../open-questions.md#q12) and in ADR-017's Unresolved.
6. **The CLI is not a consumer.** `orpc-agent inspect|snapshot|check` reads registry values and never runs a discovery ([ADR-015 §6](../architecture/decisions.md#adr-015-a-developer-cli-with-capability-inventory-as-its-first-command)), so it never sees this event. The one consumer in this repository was the Mastra example's audit panel, migrated to `data.count`.
