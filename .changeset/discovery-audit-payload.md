---
"@orpc-agent/core": major
---

**BREAKING:** `capabilities.discovered` carries constant-size data (ADR-017).

`data` was `{ capabilityIds: string[] }`. It is now `{ count, surface, digest }`, and the id list moves behind an explicit verbose audit level:

```ts
// before
sink: (e) => { if (e.type === "capabilities.discovered") report(e.data.capabilityIds.length); }

// after — no configuration change needed
sink: (e) => { if (e.type === "capabilities.discovered") report(e.data.count); }

// after — if you genuinely need the ids
createAgentRuntime({ governance, audit: { sinks: [sink], verbose: true } });  // restores data.capabilityIds
```

Why it is worth a major rather than a deprecation cycle: at 300 capabilities the id array was ~6 KB emitted on **every** discovery — per step, per turn, per concurrent user — and consumers forwarding audit events to a client carried it over the wire each time. Deprecating the field instead would have preserved that cost for a whole major cycle while shipping two payload shapes at once, which is the thing this event's size problem *is*.

`digest` hashes the sorted id list, so equal digests mean equal catalogs — enough to answer "did this actor's visible surface change" without carrying it. The algorithm is not part of the contract: compare digests, never parse one, reconstruct ids from one, or store one as a durable identifier.
