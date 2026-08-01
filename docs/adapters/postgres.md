# Postgres persistence

> Package: `@orpc-agent/postgres`. Peer: `@orpc-agent/core` only — **no database driver dependency**. Design bounds: [ADR-013](../architecture/decisions.md#adr-013-postgres-reference-persistence-package), resolving [Q8](../open-questions.md#q8).

Reference implementations of the two durability seams: `ApprovalCoordinator` (restart-surviving approvals, [ADR-006](../architecture/decisions.md#adr-006-approvals-are-external-and-input-bound)/[ADR-007](../architecture/decisions.md#adr-007-durable-execution-is-adapter-based)) and `AuditSink` (durable audit trail, [ADR-010](../architecture/decisions.md#adr-010-audit-events-are-structured-and-storage-neutral)). Both behave exactly like their in-memory counterparts — the same behavioral contract suite runs against both.

## Usage

```ts
import pg from "pg";
import {
  createPgApprovalCoordinator,
  createPgAuditSink,
  APPROVALS_DDL,
  AUDIT_DDL,
} from "@orpc-agent/postgres";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
// One-time schema setup (migration file, deploy hook — your choice):
// await pool.query(APPROVALS_DDL); await pool.query(AUDIT_DDL);

const query = (sql: string, params: unknown[]) => pool.query(sql, params);
const auditSink = createPgAuditSink({ query });

const runtime = createAgentRuntime({
  governance,
  approvals: { coordinator: createPgApprovalCoordinator({ query }) },
  audit: { sinks: [auditSink], strict: true },
});
```

The `query` function is the whole driver seam: `(sql, params) => Promise<{ rows }>`. A `pg.Pool`, a single `pg.Client`, [pglite](https://pglite.dev) (`(sql, params) => db.query(sql, params)`), and serverless drivers all satisfy it in one line. The package never imports a driver — CI enforces that.

## Schema

`APPROVALS_DDL` and `AUDIT_DDL` are canonical DDL strings for the default table names (`orpc_agent_approvals`, `orpc_agent_audit_events`): one table each, with the indexes the [auditing guide](../guides/auditing.md#minimal-wiring) recommends. There is deliberately no migrations framework — your application owns its schema lifecycle; apply the DDL with whatever runs your other migrations, and adapt the names if you override the `table` option (names are validated as strict identifiers before interpolation).

## Approval coordinator — contract points

| Behavior | Implementation |
|---|---|
| Atomic consumption (T8) | `markConsumed` is a single conditional `UPDATE … WHERE status='approved' AND consumed_by_execution_id IS NULL` — no transaction, no `SELECT … FOR UPDATE`; verified by a two-connection race test |
| Deciding | Same compare-and-set shape, `WHERE status='pending' AND expires_at > $now` |
| Expiry | Lazy, computed on read against the **coordinator's clock** (`now` option, passed as a SQL parameter — never the database clock); only pending records expire, post-approval expiry stays the resume pipeline's check |
| Input storage | Validated input stored verbatim (jsonb) so the SI-5 hash check detects drift on resume |

### The JSON round-trip caveat

Persisted inputs revive as plain JSON: a `Date` inside an input comes back as an ISO string, so a `z.date()` input schema fails re-validation at resume. That failure is **safe** (the approval is not consumed) but not what you want — approval-gated capabilities should use string schemas for temporal fields (`z.iso.datetime()`), which also hash deterministically. Same for `undefined` vs `null`: SQL `NULL` revives as `undefined`; an input that is literally `null` trips the hash re-check instead of silently drifting.

## Audit sink — strict mode and batching

By default every event is one awaited `INSERT` — strict mode (`audit: { sinks, strict: true }`) works unmodified, because the runtime awaits the sink's promise for `capability.started` before executing (T12).

`batch: { size, flushMs }` buffers events into multi-row inserts, with one non-negotiable rule ([ADR-013](../architecture/decisions.md#adr-013-postgres-reference-persistence-package)): **`capability.started` always writes through as an individually awaited insert**, in every configuration. Buffering the started event would make strict mode's audit-before-effect guarantee silently false. Buffered events' sink promises settle at flush, so the runtime's per-event `onSinkError` routing keeps working; `flush()` forces a write and `close()` flushes on shutdown. Terminal events remain best-effort exactly as core documents — a crashed process can lose a `completed` row, never an execution without its `started`.

With three users and modest traffic, skip `batch` entirely.

## Options

**`createPgApprovalCoordinator(options)`**

| Option | Default | |
|---|---|---|
| `query` | — (required) | `(sql, params) => Promise<{ rows }>` |
| `table` | `"orpc_agent_approvals"` | Optionally schema-qualified; validated identifier |
| `now` | system clock | The coordinator's clock — drives every expiry comparison |

**`createPgAuditSink(options)`**

| Option | Default | |
|---|---|---|
| `query` | — (required) | as above |
| `table` | `"orpc_agent_audit_events"` | as above |
| `batch` | none (insert per event) | `{ size?: 50, flushMs?: 250 }`; `capability.started` always bypasses |

## Testing your integration

The package's own suite runs the shared coordinator contract (`test-fixtures/approval-coordinator-contract.ts`) against pglite in CI and against a real server when `TEST_DATABASE_URL` is set — including a genuine two-connection `markConsumed` race. If you write a custom store instead ([the recipe](../guides/human-approval.md#production-coordinator)), run the same contract against it.

## Related

- [Guide: human approval](../guides/human-approval.md) · [Guide: auditing](../guides/auditing.md) · [Reference: configuration](../reference/configuration.md)
