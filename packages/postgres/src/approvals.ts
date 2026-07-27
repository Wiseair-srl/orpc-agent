import type {
  Actor,
  ApprovalCoordinator,
  ApprovalDecision,
  ApprovalRecord,
  ApprovalRequest,
  ApprovalStatus,
} from "@orpc-agent/core";
import { assertTableName, fromJsonb, toDate, type PgQuery } from "./query";

/**
 * Postgres reference ApprovalCoordinator (ADR-013). Same behavioral contract
 * as the in-memory coordinator (test-fixtures/approval-coordinator-contract):
 * compare-and-set decide/markConsumed (T8), lazy expiry computed against the
 * injected clock, records stored verbatim so the SI-5 hash check can detect
 * drift on resume.
 */

export type PgApprovalCoordinatorOptions = {
  query: PgQuery;
  /** Optionally schema-qualified. Default "orpc_agent_approvals". */
  table?: string;
  now?: () => Date;
};

const DEFAULT_TABLE = "orpc_agent_approvals";

function approvalsDdl(table: string): string {
  const indexPrefix = table.replace(".", "_");
  return `create table if not exists ${table} (
  id                       text primary key,
  capability_id            text not null,
  surface                  text not null,
  actor                    jsonb not null,
  input                    jsonb,
  input_hash               text not null,
  reasons                  jsonb not null,
  types                    jsonb not null,
  risk                     text not null,
  side_effect              text not null,
  status                   text not null,
  requested_at             timestamptz not null,
  expires_at               timestamptz not null,
  decided_by               jsonb,
  decided_at               timestamptz,
  decision_comment         text,
  consumed_by_execution_id text
);
create index if not exists ${indexPrefix}_status_idx on ${table} (status, expires_at);
create index if not exists ${indexPrefix}_capability_idx on ${table} (capability_id, requested_at);
`;
}

/** Canonical DDL for the default table name; adapt the name if you override it. */
export const APPROVALS_DDL = approvalsDdl(DEFAULT_TABLE);

// Local copy of core's actor well-formedness guard (not part of core's public
// API); the coordinator validates before touching storage, like in-memory.
function isWellFormedActor(value: unknown): value is Actor {
  if (typeof value !== "object" || value === null) return false;
  const actor = value as Record<string, unknown>;
  return (
    typeof actor.id === "string" &&
    actor.id.length > 0 &&
    (actor.kind === "user" ||
      actor.kind === "service" ||
      actor.kind === "automation" ||
      actor.kind === "anonymous")
  );
}

export function createPgApprovalCoordinator(
  options: PgApprovalCoordinatorOptions,
): ApprovalCoordinator {
  if (typeof options?.query !== "function") {
    throw new TypeError("createPgApprovalCoordinator: options.query is required");
  }
  const query = options.query;
  const table = assertTableName(options.table ?? DEFAULT_TABLE);
  const now = options.now ?? (() => new Date());

  function mapRow(row: Record<string, unknown>): ApprovalRecord {
    const expiresAt = toDate(row.expires_at);
    const stored = row.status as ApprovalStatus;
    // Lazy expiry against the coordinator's clock — computed on read, never
    // written back. Only pending records expire; post-approval expiry is the
    // resume pipeline's check (APPROVAL_EXPIRED), not the store's.
    const status: ApprovalStatus =
      stored === "pending" && now().getTime() > expiresAt.getTime() ? "expired" : stored;

    const record: ApprovalRecord = {
      id: row.id as string,
      capabilityId: row.capability_id as string,
      surface: row.surface as ApprovalRecord["surface"],
      actor: fromJsonb<Actor>(row.actor),
      // SQL NULL revives as `undefined` (semantically absent). A validated
      // input that is literally `null` is indistinguishable after the round
      // trip; the SI-5 hash re-check at resume fails safe on that edge.
      input: row.input === null ? undefined : fromJsonb<unknown>(row.input),
      inputHash: row.input_hash as string,
      reasons: fromJsonb<string[]>(row.reasons),
      types: fromJsonb<string[]>(row.types),
      risk: row.risk as ApprovalRecord["risk"],
      sideEffect: row.side_effect as ApprovalRecord["sideEffect"],
      requestedAt: toDate(row.requested_at),
      expiresAt,
      status,
    };
    if (row.decided_by !== null && row.decided_by !== undefined) {
      record.decision = {
        status: stored === "rejected" ? "rejected" : "approved",
        approver: fromJsonb<Actor>(row.decided_by),
        decidedAt: toDate(row.decided_at),
        ...(row.decision_comment !== null && row.decision_comment !== undefined
          ? { comment: row.decision_comment as string }
          : {}),
      };
    }
    if (row.consumed_by_execution_id !== null && row.consumed_by_execution_id !== undefined) {
      record.consumedByExecutionId = row.consumed_by_execution_id as string;
    }
    return record;
  }

  async function readRow(id: string): Promise<Record<string, unknown> | undefined> {
    const { rows } = await query(`select * from ${table} where id = $1`, [id]);
    return rows[0];
  }

  function mustHaveRow(
    id: string,
    row: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    if (!row) throw new Error(`Approval "${id}" was not found`);
    return row;
  }

  return {
    async create(request: ApprovalRequest): Promise<ApprovalRecord> {
      const { rows } = await query(
        `insert into ${table} (
           id, capability_id, surface, actor, input, input_hash, reasons, types,
           risk, side_effect, status, requested_at, expires_at
         ) values ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7::jsonb,$8::jsonb,$9,$10,'pending',$11::timestamptz,$12::timestamptz)
         on conflict (id) do nothing
         returning *`,
        [
          request.id,
          request.capabilityId,
          request.surface,
          JSON.stringify(request.actor),
          request.input === undefined ? null : JSON.stringify(request.input),
          request.inputHash,
          JSON.stringify(request.reasons),
          JSON.stringify(request.types),
          request.risk,
          request.sideEffect,
          request.requestedAt.toISOString(),
          request.expiresAt.toISOString(),
        ],
      );
      if (rows.length === 0) {
        throw new Error(`Approval "${request.id}" already exists`);
      }
      return mapRow(rows[0]!);
    },

    async get(id: string): Promise<ApprovalRecord | null> {
      const row = await readRow(id);
      return row ? mapRow(row) : null;
    },

    async decide(id: string, decision: ApprovalDecision): Promise<ApprovalRecord> {
      if (decision.status !== "approved" && decision.status !== "rejected") {
        throw new Error(`Invalid decision status "${String(decision.status)}"`);
      }
      if (!isWellFormedActor(decision.approver)) {
        throw new Error("Decision approver must be a well-formed actor");
      }
      // Compare-and-set: only a pending, unexpired row transitions. The expiry
      // predicate uses the injected clock as a parameter, never the DB clock.
      const { rows } = await query(
        `update ${table}
            set status = $2, decided_by = $3::jsonb, decided_at = $4::timestamptz, decision_comment = $5
          where id = $1 and status = 'pending' and expires_at > $4::timestamptz
          returning *`,
        [
          id,
          decision.status,
          JSON.stringify(decision.approver),
          now().toISOString(),
          decision.comment ?? null,
        ],
      );
      if (rows.length === 0) {
        const record = mapRow(mustHaveRow(id, await readRow(id)));
        throw new Error(`Approval "${id}" is not pending (status: ${record.status})`);
      }
      return mapRow(rows[0]!);
    },

    async markConsumed(id: string, executionId: string): Promise<ApprovalRecord> {
      // The T8 obligation: a single conditional UPDATE is the atomic
      // check-and-set — no transaction, no row lock.
      const { rows } = await query(
        `update ${table}
            set status = 'consumed', consumed_by_execution_id = $2
          where id = $1 and status = 'approved' and consumed_by_execution_id is null
          returning *`,
        [id, executionId],
      );
      if (rows.length === 0) {
        const record = mapRow(mustHaveRow(id, await readRow(id)));
        throw new Error(
          `Approval "${id}" cannot be consumed (status: ${record.status}${
            record.consumedByExecutionId ? `, consumed by ${record.consumedByExecutionId}` : ""
          })`,
        );
      }
      return mapRow(rows[0]!);
    },

    async list(filter?: {
      status?: ApprovalStatus;
      capabilityId?: string;
      actorId?: string;
    }): Promise<ApprovalRecord[]> {
      // Status filtering happens after mapping so it observes the lazily
      // computed "expired" state, exactly like the in-memory coordinator.
      const { rows } = await query(
        `select * from ${table}
          where ($1::text is null or capability_id = $1)
            and ($2::text is null or actor->>'id' = $2)
          order by requested_at asc, id asc`,
        [filter?.capabilityId ?? null, filter?.actorId ?? null],
      );
      return rows
        .map((row) => mapRow(row))
        .filter((record) => filter?.status === undefined || record.status === filter.status);
    },
  };
}
