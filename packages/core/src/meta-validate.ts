import { EXPOSURE_SURFACES, RISK_LEVELS, SIDE_EFFECTS } from "./types";
import type { AgentMeta } from "./meta";

const WRITE_LIKE = new Set(["write", "destructive", "external"]);

/**
 * Validates one capability's `agent` metadata. Returns problem strings
 * (prefixed by the caller with the capability id); empty when valid.
 * Rules: docs/reference/metadata.md#validation-at-registry-build.
 */
export function validateAgentMeta(meta: unknown): string[] {
  const problems: string[] = [];
  if (typeof meta !== "object" || meta === null) {
    return ["agent metadata must be an object"];
  }
  const m = meta as Record<string, unknown>;

  if (typeof m.description !== "string" || m.description.trim().length === 0) {
    problems.push('missing required "description" (non-empty string)');
  }

  if (typeof m.expose !== "object" || m.expose === null || Array.isArray(m.expose)) {
    problems.push('missing required "expose" (per-surface map; deny-by-default)');
  } else {
    for (const [key, value] of Object.entries(m.expose)) {
      if (!(EXPOSURE_SURFACES as readonly string[]).includes(key)) {
        problems.push(
          `unknown surface "${key}" in expose (known: ${EXPOSURE_SURFACES.join(", ")})`,
        );
      } else if (typeof value !== "boolean") {
        problems.push(`expose.${key} must be a boolean`);
      }
    }
  }

  if (!(SIDE_EFFECTS as readonly unknown[]).includes(m.sideEffect)) {
    problems.push(`missing or invalid required "sideEffect" (one of ${SIDE_EFFECTS.join(", ")})`);
  }

  if (!(RISK_LEVELS as readonly unknown[]).includes(m.risk)) {
    problems.push(`missing or invalid required "risk" (one of ${RISK_LEVELS.join(", ")})`);
  }

  if (m.tags !== undefined) {
    if (!Array.isArray(m.tags) || m.tags.some((t) => typeof t !== "string")) {
      problems.push('"tags" must be an array of strings');
    }
  }

  if (m.timeoutMs !== undefined) {
    if (typeof m.timeoutMs !== "number" || !Number.isFinite(m.timeoutMs) || m.timeoutMs <= 0) {
      problems.push('"timeoutMs" must be a positive number');
    }
  }

  if (m.idempotent !== undefined && typeof m.idempotent !== "boolean") {
    problems.push('"idempotent" must be a boolean');
  }

  if (m.retry !== undefined) {
    if (typeof m.retry !== "object" || m.retry === null) {
      problems.push('"retry" must be an object');
    } else {
      const retry = m.retry as Record<string, unknown>;
      if (
        typeof retry.maxAttempts !== "number" ||
        !Number.isInteger(retry.maxAttempts) ||
        retry.maxAttempts < 0
      ) {
        problems.push('"retry.maxAttempts" must be a non-negative integer');
      }
      if (
        retry.backoffMs !== undefined &&
        (typeof retry.backoffMs !== "number" ||
          !Number.isFinite(retry.backoffMs) ||
          retry.backoffMs <= 0)
      ) {
        problems.push('"retry.backoffMs" must be a positive number');
      }
      if (retry.retryOn !== undefined && typeof retry.retryOn !== "function") {
        problems.push('"retry.retryOn" must be a function');
      }
      if (
        typeof retry.maxAttempts === "number" &&
        retry.maxAttempts > 0 &&
        WRITE_LIKE.has(m.sideEffect as string) &&
        m.idempotent !== true
      ) {
        problems.push(
          `retry configured on a "${String(m.sideEffect)}" capability without "idempotent: true" — ` +
            "the runtime never auto-retries write-like operations absent an explicit idempotency declaration (SI-11)",
        );
      }
    }
  }

  if (m.approval !== undefined) {
    if (typeof m.approval !== "object" || m.approval === null) {
      problems.push('"approval" must be an object');
    } else {
      const approval = m.approval as Record<string, unknown>;
      if (approval.required !== undefined && typeof approval.required !== "boolean") {
        problems.push('"approval.required" must be a boolean');
      }
      if (approval.type !== undefined && typeof approval.type !== "string") {
        problems.push('"approval.type" must be a string');
      }
      if (
        approval.expiresInMs !== undefined &&
        (typeof approval.expiresInMs !== "number" ||
          !Number.isFinite(approval.expiresInMs) ||
          approval.expiresInMs <= 0)
      ) {
        problems.push('"approval.expiresInMs" must be a positive number');
      }
    }
  }

  if (m.redact !== undefined) {
    if (typeof m.redact !== "object" || m.redact === null) {
      problems.push('"redact" must be an object');
    } else {
      const redact = m.redact as Record<string, unknown>;
      if (redact.output !== undefined && typeof redact.output !== "function") {
        problems.push('"redact.output" must be a function');
      }
      if (redact.approvalInput !== undefined && typeof redact.approvalInput !== "function") {
        problems.push('"redact.approvalInput" must be a function');
      }
    }
  }

  if (m.policies !== undefined) {
    if (
      !Array.isArray(m.policies) ||
      m.policies.some(
        (p) =>
          typeof p !== "object" ||
          p === null ||
          typeof (p as Record<string, unknown>).name !== "string" ||
          typeof (p as Record<string, unknown>).evaluate !== "function",
      )
    ) {
      problems.push('"policies" must be an array of AgentPolicy objects (use definePolicy)');
    }
  }

  if (m.adapters !== undefined) {
    if (typeof m.adapters !== "object" || m.adapters === null) {
      problems.push('"adapters" must be an object');
    } else {
      const adapters = m.adapters as Record<string, Record<string, unknown> | undefined>;
      for (const key of ["aiSdk", "mcp"] as const) {
        const section = adapters[key];
        if (section === undefined) continue;
        if (typeof section !== "object" || section === null) {
          problems.push(`"adapters.${key}" must be an object`);
          continue;
        }
        if (
          section.toolName !== undefined &&
          (typeof section.toolName !== "string" || section.toolName.length === 0)
        ) {
          problems.push(`"adapters.${key}.toolName" must be a non-empty string`);
        }
      }
      const mcp = adapters.mcp;
      if (
        mcp &&
        mcp.annotations !== undefined &&
        (typeof mcp.annotations !== "object" || mcp.annotations === null)
      ) {
        problems.push('"adapters.mcp.annotations" must be an object');
      }
    }
  }

  return problems;
}

/** Resolves optional collection defaults so downstream code can rely on them. */
export function normalizeAgentMeta(meta: AgentMeta): AgentMeta {
  return {
    ...meta,
    tags: meta.tags ?? [],
    policies: meta.policies ?? [],
    idempotent: meta.idempotent ?? false,
  };
}
