import type { PolicyDecision } from "./types";

/** Proceed; metadata lands in the audit record. */
export function allow(metadata?: Record<string, unknown>): PolicyDecision {
  return metadata === undefined ? { type: "allow" } : { type: "allow", metadata };
}

/**
 * Stop with `POLICY_DENIED`. `message` becomes the public message of the
 * resulting error — write it for a model to read, leak nothing.
 */
export function deny(code?: string, message?: string): PolicyDecision {
  const decision: PolicyDecision = { type: "deny" };
  if (code !== undefined) (decision as { code?: string }).code = code;
  if (message !== undefined) (decision as { message?: string }).message = message;
  return decision;
}

/**
 * At discovery: exclude from listings. Elsewhere: concealing deny
 * (`CAPABILITY_NOT_FOUND`, SI-8).
 */
export function hide(): PolicyDecision {
  return { type: "hide" };
}

/** Gate at pipeline stage 8. */
export function requireApproval(opts: {
  reason: string;
  approvalType?: string;
  expiresInMs?: number;
}): PolicyDecision {
  if (typeof opts?.reason !== "string" || opts.reason.length === 0) {
    throw new TypeError("requireApproval: a non-empty reason is required");
  }
  return { type: "require-approval", ...opts };
}
