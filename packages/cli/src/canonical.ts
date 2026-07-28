import { createHash } from "node:crypto";

/**
 * Recursively key-sorted clone, used only on values whose key order comes
 * from outside this package (JSON Schema conversion gives no ordering
 * guarantee across library versions). Snapshot entries are not canonicalized:
 * they are built in a fixed field order, which is both deterministic and
 * readable in a diff — `id` first rather than alphabetically buried.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue;
    result[key] = canonicalize(source[key]);
  }
  return result;
}

/** Canonical JSON with no whitespace — the hashing input. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** The on-disk snapshot form: stable indentation, trailing newline. */
export function snapshotJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}
