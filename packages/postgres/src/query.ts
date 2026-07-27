/**
 * The driver seam (ADR-013): implementations receive SQL + positional params
 * and return rows. `pg.Pool`, pglite, and serverless drivers all adapt in one
 * line, e.g. `(sql, params) => pool.query(sql, params)`.
 */
export type PgQuery = (
  sql: string,
  params: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;

/**
 * Table names are interpolated into SQL (they cannot be bound parameters), so
 * they are validated as strict identifiers: lowercase segments, optionally one
 * schema qualifier.
 */
export function assertTableName(table: string): string {
  if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/.test(table)) {
    throw new TypeError(
      `Invalid table name "${table}" — expected lowercase identifier segments ` +
        `([a-z_][a-z0-9_]*), optionally schema-qualified`,
    );
  }
  return table;
}

/** timestamptz round-trip: drivers return Date or ISO string depending on protocol. */
export function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(value as string);
}

/** jsonb round-trip: drivers return parsed values or raw JSON text. */
export function fromJsonb<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}
