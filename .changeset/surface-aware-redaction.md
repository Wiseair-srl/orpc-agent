---
"@orpc-agent/core": minor
---

Redaction hooks are surface-aware. `redact.output` and `redact.approvalInput` receive a frozen `RedactionInfo` (`surface`, `capabilityId`, `actor`, `context`) as a second argument, so the same capability can redact for external MCP clients and pass through for an internal console on `aiSdk`. The surface comes from the authenticated frame or, on a resumed approval, from the record — never from model input or request JSON. One-argument hooks keep working. New `redactApprovalInput(registry, record, { context })` applies the display hook with the record's own surface and fails closed instead of falling back to the raw input.
