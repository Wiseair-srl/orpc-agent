/**
 * Canonical JSON serialization (lexicographically sorted object keys, UTF-8,
 * no insignificant whitespace) and SHA-256 hashing. Approval integrity (SI-5)
 * binds the hash of the canonical validated input.
 */

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

export function canonicalJson(value: unknown): string {
  return serialize(value, new Set());
}

function serialize(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError("non-finite numbers are not serializable");
      }
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "bigint":
      throw new CanonicalizationError("bigint values are not serializable");
    case "function":
      throw new CanonicalizationError("functions are not serializable");
    case "symbol":
      throw new CanonicalizationError("symbols are not serializable");
    case "undefined":
      throw new CanonicalizationError("undefined is not serializable");
  }

  const obj = value as object;
  if (seen.has(obj)) {
    throw new CanonicalizationError("circular structures are not serializable");
  }

  // Honor toJSON (Date, custom classes) — standard JSON semantics.
  if (typeof (obj as { toJSON?: unknown }).toJSON === "function") {
    return serialize((obj as { toJSON: () => unknown }).toJSON(), seen);
  }

  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const items = obj.map((item) =>
        // JSON aliases undefined holes to null; that loses no governable data.
        // Functions/symbols would alias real data — reject instead (SI-5).
        item === undefined ? "null" : serialize(item, seen),
      );
      return `[${items.join(",")}]`;
    }

    const proto = Object.getPrototypeOf(obj);
    if (proto !== null && proto !== Object.prototype) {
      throw new CanonicalizationError(
        `values of type ${obj.constructor?.name ?? "unknown"} are not serializable`,
      );
    }

    const keys = Object.keys(obj).sort();
    const entries: string[] = [];
    for (const key of keys) {
      const entryValue = (obj as Record<string, unknown>)[key];
      // undefined-valued keys are dropped (semantically "absent"). Functions
      // and symbols are NOT silently dropped: an approval hash must never bind
      // less than the value that will execute (SI-5).
      if (entryValue === undefined) continue;
      entries.push(`${JSON.stringify(key)}:${serialize(entryValue, seen)}`);
    }
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(obj);
  }
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** sha256 of canonical JSON. Throws `CanonicalizationError` when unserializable. */
export async function hashInput(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}
