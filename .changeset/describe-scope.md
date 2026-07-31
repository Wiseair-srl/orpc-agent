---
"@orpc-agent/core": minor
"@orpc-agent/testing": minor
---

`describe` accepts a scope, applied before any discovery policy runs (ADR-017).

```ts
runtime.describe("aiSdk", { actor, context, scope: { tags: ["devices"] } });
```

- `tags` matches capabilities carrying ANY listed tag; `ids` selects exactly; both given, the union. An untagged capability matches no `tags` scope, and `scope: {}` does not narrow.
- The filter sits between the exposure filter and the discovery-phase policies. After the policies it would save tokens; before them it saves the evaluations, the schema conversions, and the clones for everything the caller was about to discard.
- **Not an authority boundary.** `invoke` does not consult scope, in this or any later release: a capability outside the requested scope stays fully invocable by an authorized actor, exactly as adapter-level `filter` behaves. Use exposure or a policy to make one unreachable (SI-2).
- Purely additive — omitting `scope` returns the 1.0 result, in the same order. `@orpc-agent/testing`'s `describe` forwards it too.
