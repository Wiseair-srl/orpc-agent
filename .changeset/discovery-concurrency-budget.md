---
"@orpc-agent/core": minor
---

Discovery-phase policies evaluate concurrently, under a budget for the whole `describe` (ADR-017).

- `defaults.policyConcurrency` (default 16) bounds how many capabilities' policy batches evaluate at once. Within one capability nothing changes: same order, same shared batch deadline, and a policy error still excludes exactly its own capability (SI-7). Descriptor order stays registry order.
- `defaults.discoveryBudgetMs` (default 30_000) bounds the whole discovery, where `policyTimeoutMs` only ever bounded one capability's batch — worst case at 300 capabilities was 300 × `policyTimeoutMs`.
- On expiry `describe` rejects with `CapabilityError` (`TIMEOUT` @ `discovery`) instead of returning a short catalog: a silently truncated listing is indistinguishable from "this actor lost access".
- Discovery policies should stay synchronous or memoized; batch unavoidable lookups into context construction, not per capability.
