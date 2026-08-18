---
"@orpc-agent/core": minor
---

`runtime.resume` accepts `expectedActor` / `expectedSurface` binding guards for adapter-relayed resume. A mismatched record fails `APPROVAL_RESUME_MISMATCH` — serialized to the caller exactly like an unknown id (SI-8), recorded truthfully in audit under the caller's identity. Guards never re-attribute: execution still runs as the record's actor.
