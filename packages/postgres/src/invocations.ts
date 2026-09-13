import type { InvocationJournal, InvocationRecord } from "@orpc-agent/core/server";
import type { CapabilityOutcome } from "@orpc-agent/core/client";
import { assertTableName, fromJsonb, type PgQuery } from "./query";

export type PgInvocationJournalOptions = { query: PgQuery; table?: string };
export const INVOCATIONS_DDL = `create table if not exists orpc_agent_invocations (
  scope text not null,
  invocation_id text not null,
  state text not null check (state in ('pending', 'settled')),
  claim_token text not null,
  approval_id text,
  record jsonb not null,
  primary key (scope, invocation_id)
);
create index if not exists orpc_agent_invocations_approval_idx on orpc_agent_invocations (scope, approval_id);
`;

/** Durable admission and receipts. Pending rows never expire into automatic re-execution. */
export function createPgInvocationJournal(options: PgInvocationJournalOptions): InvocationJournal {
  if (typeof options?.query !== "function") throw new TypeError("createPgInvocationJournal: query is required");
  const query = options.query;
  const table = assertTableName(options.table ?? "orpc_agent_invocations");
  const map = (row: Record<string, unknown>): InvocationRecord => fromJsonb<InvocationRecord>(row.record);
  async function get(scope: string, id: string) {
    const { rows } = await query(`select record from ${table} where scope = $1 and invocation_id = $2`, [scope, id]);
    return rows[0] ? map(rows[0]) : null;
  }
  return {
    get,
    async findApproval(scope, approvalId) {
      const { rows } = await query(`select record from ${table} where scope = $1 and approval_id = $2`, [scope, approvalId]);
      return rows[0] ? map(rows[0]) : null;
    },
    async claim(record) {
      const { rows } = await query(`insert into ${table} (scope, invocation_id, state, claim_token, record)
        values ($1, $2, 'pending', $3, $4::jsonb) on conflict (scope, invocation_id) do nothing returning record`,
        [record.scope, record.invocationId, record.claimToken, JSON.stringify(record)]);
      if (rows[0]) return { claimed: true, record: map(rows[0]) };
      const existing = await get(record.scope, record.invocationId);
      if (!existing) throw new Error("Invocation journal row disappeared during claim");
      return { claimed: false, record: existing };
    },
    async claimResume(scope, id, approvalId, claimToken) {
      const update = { state: "pending", claimToken, updatedAt: new Date().toISOString() };
      const { rows } = await query(`update ${table}
        set state = 'pending', claim_token = $4, record = (record - 'outcome') || $5::jsonb
        where scope = $1 and invocation_id = $2 and approval_id = $3
          and state = 'settled' and record->'outcome'->>'status' = 'approval-required'
        returning record`, [scope, id, approvalId, claimToken, JSON.stringify(update)]);
      return rows.length > 0;
    },
    async settle(scope, id, claimToken, outcome: CapabilityOutcome) {
      const update = { state: "settled", outcome, updatedAt: new Date().toISOString(), ...(outcome.status === "approval-required" ? { approvalId: outcome.approval.id } : {}) };
      const { rows } = await query(`update ${table}
        set state = 'settled', approval_id = coalesce($4, approval_id), record = record || $5::jsonb
        where scope = $1 and invocation_id = $2 and claim_token = $3 and state = 'pending'
        returning record`, [scope, id, claimToken, outcome.status === "approval-required" ? outcome.approval.id : null, JSON.stringify(update)]);
      if (!rows.length) throw new Error("Invocation ownership lost");
    },
  };
}
