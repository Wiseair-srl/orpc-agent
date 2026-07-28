# @orpc-agent/postgres

## 0.3.0

### Patch Changes

- Updated dependencies [e3469e7]
  - @orpc-agent/core@0.3.0

## 0.2.0

### Minor Changes

- fcb4412: New package: Postgres reference implementations of the durability seams (ADR-013). `createPgApprovalCoordinator` (compare-and-set decide/markConsumed, lazy clock-injected expiry, verbatim input storage) and `createPgAuditSink` (strict-mode-safe; optional terminal-event batching with `capability.started` always written through), plus `APPROVALS_DDL`/`AUDIT_DDL`. Driver-agnostic: the only runtime dependency is `@orpc-agent/core`; bring any `(sql, params) => Promise<{ rows }>` function.

### Patch Changes

- Updated dependencies [53b20a9]
  - @orpc-agent/core@0.2.0
