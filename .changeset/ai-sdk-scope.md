---
"@orpc-agent/ai-sdk": minor
---

`toAISDKTools` takes a `scope`, forwarded verbatim to `runtime.describe`.

`filter` is unchanged and still applies after, so a consumer can scope cheaply and then shape precisely: **`scope` decides what gets discovered; `filter` decides what survives discovery.** Neither is authorization (SI-2).
