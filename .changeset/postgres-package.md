---
"@orpc-agent/postgres": minor
---

New package: Postgres reference implementations of the durability seams (ADR-013). `createPgApprovalCoordinator` (compare-and-set decide/markConsumed, lazy clock-injected expiry, verbatim input storage) and `createPgAuditSink` (strict-mode-safe; optional terminal-event batching with `capability.started` always written through), plus `APPROVALS_DDL`/`AUDIT_DDL`. Driver-agnostic: the only runtime dependency is `@orpc-agent/core`; bring any `(sql, params) => Promise<{ rows }>` function.
