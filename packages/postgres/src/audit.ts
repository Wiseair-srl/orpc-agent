import type { AgentAuditEvent, AuditSink } from "@orpc-agent/core";
import { assertTableName, type PgQuery } from "./query";

/**
 * Postgres reference AuditSink (ADR-013): append-only rows, envelope fields as
 * columns, event `data` as jsonb — payload-free by the event contract (SI-10).
 *
 * Strict-mode interplay is the load-bearing rule here: `capability.started`
 * ALWAYS writes through as an individually awaited insert, in every
 * configuration, because strict mode's audit-before-effect guarantee (T12) is
 * "the started row exists before the procedure runs". Only other events may
 * buffer, and their sink promises settle at flush so the runtime's per-event
 * error routing (`onSinkError`) keeps working.
 */

export type PgAuditSinkOptions = {
  query: PgQuery;
  /** Optionally schema-qualified. Default "orpc_agent_audit_events". */
  table?: string;
  /** Buffer non-`capability.started` events. Omit for one awaited insert per event. */
  batch?: { size?: number; flushMs?: number };
};

/** Callable as an AuditSink; `flush`/`close` support graceful shutdown. */
export type PgAuditSink = AuditSink & {
  flush(): Promise<void>;
  close(): Promise<void>;
};

const DEFAULT_TABLE = "orpc_agent_audit_events";
const COLUMNS =
  "type, at, surface, actor_id, actor_kind, execution_id, capability_id, correlation_id, input_hash, data";
const COLUMN_COUNT = 10;

function auditDdl(table: string): string {
  const indexPrefix = table.replace(".", "_");
  return `create table if not exists ${table} (
  id             bigint generated always as identity primary key,
  type           text not null,
  at             timestamptz not null,
  surface        text not null,
  actor_id       text not null,
  actor_kind     text not null,
  execution_id   text,
  capability_id  text,
  correlation_id text,
  input_hash     text,
  data           jsonb not null
);
create index if not exists ${indexPrefix}_capability_at_idx on ${table} (capability_id, at);
create index if not exists ${indexPrefix}_actor_at_idx on ${table} (actor_id, at);
create index if not exists ${indexPrefix}_execution_idx on ${table} (execution_id);
`;
}

/** Canonical DDL for the default table name; adapt the name if you override it. */
export const AUDIT_DDL = auditDdl(DEFAULT_TABLE);

type Buffered = {
  event: AgentAuditEvent;
  resolve: () => void;
  reject: (error: unknown) => void;
};

export function createPgAuditSink(options: PgAuditSinkOptions): PgAuditSink {
  if (typeof options?.query !== "function") {
    throw new TypeError("createPgAuditSink: options.query is required");
  }
  const query = options.query;
  const table = assertTableName(options.table ?? DEFAULT_TABLE);
  const batch = options.batch
    ? { size: Math.max(1, options.batch.size ?? 50), flushMs: options.batch.flushMs ?? 250 }
    : undefined;

  let buffer: Buffered[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  function rowParams(event: AgentAuditEvent): unknown[] {
    return [
      event.type,
      event.timestamp.toISOString(),
      event.surface,
      event.actor.id,
      event.actor.kind,
      event.executionId ?? null,
      event.capabilityId ?? null,
      event.correlationId ?? null,
      event.inputHash ?? null,
      JSON.stringify(event.data),
    ];
  }

  async function insert(events: AgentAuditEvent[]): Promise<void> {
    const params: unknown[] = [];
    const tuples = events.map((event, index) => {
      params.push(...rowParams(event));
      const base = index * COLUMN_COUNT;
      const placeholders = Array.from({ length: COLUMN_COUNT }, (_, i) => {
        const n = base + i + 1;
        if (i === 1) return `$${n}::timestamptz`;
        if (i === COLUMN_COUNT - 1) return `$${n}::jsonb`;
        return `$${n}`;
      });
      return `(${placeholders.join(",")})`;
    });
    await query(`insert into ${table} (${COLUMNS}) values ${tuples.join(",")}`, params);
  }

  async function flush(): Promise<void> {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (buffer.length === 0) return;
    const drained = buffer;
    buffer = [];
    try {
      await insert(drained.map((entry) => entry.event));
      for (const entry of drained) entry.resolve();
    } catch (error) {
      // Each buffered event's sink promise carries the failure back to the
      // emitter, which routes it to onSinkError per event.
      for (const entry of drained) entry.reject(error);
      throw error;
    }
  }

  function scheduledFlush(): void {
    // Buffered promises carry errors to the emitter; swallow here so internal
    // triggers never produce an unhandled rejection.
    void flush().catch(() => {});
  }

  const sink = (event: AgentAuditEvent): Promise<void> => {
    if (!batch || closed || event.type === "capability.started") {
      return insert([event]);
    }
    return new Promise<void>((resolve, reject) => {
      buffer.push({ event, resolve, reject });
      if (buffer.length >= batch.size) {
        scheduledFlush();
      } else if (timer === undefined) {
        timer = setTimeout(scheduledFlush, batch.flushMs);
        timer.unref?.();
      }
    });
  };

  return Object.assign(sink, {
    flush: () => flush(),
    close: async () => {
      closed = true;
      await flush();
    },
  });
}
