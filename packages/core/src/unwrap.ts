import { CapabilityError } from "./errors";
import type { ExecutionResult } from "./runtime/types";

/**
 * Convenience for direct/workflow callers: returns `output` for `completed`,
 * throws the contained CapabilityError for `failed`/`cancelled`, and throws a
 * CapabilityError with code APPROVAL_REQUIRED (carrying the approval record in
 * `details`) for `approval-required`. Adapters do not use it — they translate
 * envelopes.
 */
export function unwrap<O>(result: ExecutionResult<O>): O {
  switch (result.status) {
    case "completed":
      return result.output;
    case "approval-required":
      throw new CapabilityError({
        code: "APPROVAL_REQUIRED",
        details: { approval: result.approval },
      });
    case "failed":
    case "cancelled":
      throw result.error;
  }
}
