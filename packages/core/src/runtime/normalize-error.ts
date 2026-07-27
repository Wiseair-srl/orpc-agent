import { ORPCError, ValidationError } from "@orpc/server";
import { CapabilityError } from "../errors";

export type ValidationIssueSummary = { path: string[]; message: string };

/** Issue paths and messages only — values are never echoed. */
export function summarizeIssues(
  issues: readonly { message: string; path?: readonly unknown[] | undefined }[],
): ValidationIssueSummary[] {
  return issues.map((issue) => ({
    path: (issue.path ?? []).map((segment) =>
      typeof segment === "object" && segment !== null && "key" in segment
        ? String((segment as { key: unknown }).key)
        : String(segment),
    ),
    message: issue.message,
  }));
}

/**
 * Maps whatever pipeline stage 11 (the oRPC call) threw to a CapabilityError,
 * per docs/reference/errors.md#relationship-to-orpc-errors. Version-coupled to
 * @orpc/server's validation error shapes (pinned; see ADR-001 addendum).
 */
export function normalizeExecutionError(thrown: unknown): CapabilityError {
  if (thrown instanceof CapabilityError) return thrown;

  if (thrown instanceof ORPCError) {
    // oRPC's own input validation inside the call path.
    if (thrown.code === "BAD_REQUEST" && thrown.cause instanceof ValidationError) {
      return new CapabilityError({
        code: "INPUT_INVALID",
        details: { issues: summarizeIssues(thrown.cause.issues ?? []) },
        cause: thrown,
      });
    }
    // oRPC's output validation: the handler broke its own contract (stage 12).
    if (thrown.code === "INTERNAL_SERVER_ERROR" && thrown.cause instanceof ValidationError) {
      return new CapabilityError({ code: "OUTPUT_INVALID", cause: thrown });
    }
    if (thrown.code === "UNAUTHORIZED") {
      return new CapabilityError({
        code: "UNAUTHENTICATED",
        publicMessage: thrown.message || undefined,
        cause: thrown,
      });
    }
    if (thrown.code === "FORBIDDEN") {
      return new CapabilityError({
        code: "FORBIDDEN",
        publicMessage: thrown.message || undefined,
        cause: thrown,
      });
    }
    // Declared type-safe errors and other ORPCErrors are contract-level:
    // exposeToModel with their message.
    return new CapabilityError({
      code: "EXECUTION_FAILED",
      exposeToModel: true,
      publicMessage: thrown.message || "The operation failed.",
      cause: thrown,
    });
  }

  // Undeclared throws are internals: concealed (SI-9).
  return new CapabilityError({
    code: "EXECUTION_FAILED",
    exposeToModel: false,
    publicMessage: "The operation failed.",
    cause: thrown,
  });
}
