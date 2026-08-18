/**
 * Normalized error model. Every failure a caller can observe is a
 * `CapabilityError` with a model-safe face (`code`, `publicMessage`,
 * `retryable`) and a private diagnostic body (`stage`, `details`, `cause`).
 * Contract: docs/reference/errors.md.
 */

export type FailureStage =
  | "discovery"
  | "input-validation"
  | "authentication"
  | "authorization"
  | "policy"
  | "approval"
  | "execution"
  | "output-validation"
  | "timeout"
  | "cancellation"
  | "adapter";

export type ErrorCode =
  | "CAPABILITY_NOT_FOUND"
  | "INPUT_INVALID"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "POLICY_DENIED"
  | "POLICY_FAILED"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_PENDING"
  | "APPROVAL_REJECTED"
  | "APPROVAL_EXPIRED"
  | "APPROVAL_CONSUMED"
  | "APPROVAL_INPUT_MISMATCH"
  | "APPROVAL_SELF_APPROVAL"
  | "APPROVAL_UNSERIALIZABLE_INPUT"
  | "APPROVAL_RESUME_MISMATCH"
  | "EXECUTION_FAILED"
  | "OUTPUT_INVALID"
  | "TIMEOUT"
  | "CANCELLED"
  | "AUDIT_UNAVAILABLE"
  | "ADAPTER_ERROR"
  | "INTERNAL_ERROR";

type CodeDefaults = {
  stage: FailureStage;
  retryable: boolean;
  exposeToModel: boolean;
  publicMessage: string;
};

/**
 * Per-code defaults. `publicMessage` for CAPABILITY_NOT_FOUND is a constant
 * (no interpolation) so unknown, unexposed, and hidden capabilities are
 * byte-identical externally (SI-8).
 */
export const ERROR_CODE_DEFAULTS: Record<ErrorCode, CodeDefaults> = {
  CAPABILITY_NOT_FOUND: {
    stage: "discovery",
    retryable: false,
    exposeToModel: true,
    publicMessage: "Capability not found.",
  },
  INPUT_INVALID: {
    stage: "input-validation",
    retryable: false,
    exposeToModel: true,
    publicMessage: "Input validation failed.",
  },
  UNAUTHENTICATED: {
    stage: "authentication",
    retryable: false,
    exposeToModel: true,
    publicMessage: "Authentication is required.",
  },
  FORBIDDEN: {
    stage: "authorization",
    retryable: false,
    exposeToModel: true,
    publicMessage: "The operation is not permitted.",
  },
  POLICY_DENIED: {
    stage: "policy",
    retryable: false,
    exposeToModel: true,
    publicMessage: "The operation was denied by policy.",
  },
  POLICY_FAILED: {
    stage: "policy",
    retryable: false,
    exposeToModel: false,
    publicMessage: "The operation failed.",
  },
  APPROVAL_REQUIRED: {
    stage: "approval",
    retryable: false,
    exposeToModel: true,
    publicMessage: "Approval is required for this operation.",
  },
  APPROVAL_PENDING: {
    stage: "approval",
    retryable: true,
    exposeToModel: true,
    publicMessage: "The approval decision is still pending.",
  },
  APPROVAL_REJECTED: {
    stage: "approval",
    retryable: false,
    exposeToModel: true,
    publicMessage: "The approval was rejected.",
  },
  APPROVAL_EXPIRED: {
    stage: "approval",
    retryable: false,
    exposeToModel: true,
    publicMessage: "The approval has expired; a new request is required.",
  },
  APPROVAL_CONSUMED: {
    stage: "approval",
    retryable: false,
    exposeToModel: true,
    publicMessage: "The approval has already been used.",
  },
  APPROVAL_INPUT_MISMATCH: {
    stage: "approval",
    retryable: false,
    exposeToModel: false,
    publicMessage: "The operation failed.",
  },
  APPROVAL_SELF_APPROVAL: {
    stage: "approval",
    retryable: false,
    exposeToModel: true,
    publicMessage: "The approver must differ from the requesting actor.",
  },
  APPROVAL_UNSERIALIZABLE_INPUT: {
    stage: "approval",
    retryable: false,
    exposeToModel: false,
    publicMessage: "The operation failed.",
  },
  // Not exposed: to the caller a record bound to someone else must be
  // indistinguishable from a record that does not exist (SI-8). Audit gets
  // the real code.
  APPROVAL_RESUME_MISMATCH: {
    stage: "approval",
    retryable: false,
    exposeToModel: false,
    publicMessage: "The operation failed.",
  },
  EXECUTION_FAILED: {
    stage: "execution",
    retryable: false,
    exposeToModel: false,
    publicMessage: "The operation failed.",
  },
  OUTPUT_INVALID: {
    stage: "output-validation",
    retryable: false,
    exposeToModel: false,
    publicMessage: "The operation failed.",
  },
  TIMEOUT: {
    stage: "timeout",
    retryable: true,
    exposeToModel: true,
    publicMessage: "The operation timed out.",
  },
  CANCELLED: {
    stage: "cancellation",
    retryable: false,
    exposeToModel: true,
    publicMessage: "The operation was cancelled.",
  },
  AUDIT_UNAVAILABLE: {
    stage: "execution",
    retryable: true,
    exposeToModel: false,
    publicMessage: "The operation failed.",
  },
  ADAPTER_ERROR: {
    stage: "adapter",
    retryable: false,
    exposeToModel: false,
    publicMessage: "The operation failed.",
  },
  INTERNAL_ERROR: {
    stage: "execution",
    retryable: false,
    exposeToModel: false,
    publicMessage: "The operation failed.",
  },
};

export type CapabilityErrorOptions = {
  code: ErrorCode;
  stage?: FailureStage;
  publicMessage?: string;
  retryable?: boolean;
  exposeToModel?: boolean;
  details?: unknown;
  cause?: unknown;
};

export class CapabilityError extends Error {
  readonly code: ErrorCode;
  readonly stage: FailureStage;
  /** Model-safe; the ONLY message adapters may forward. */
  readonly publicMessage: string;
  /** May an identical request succeed later? */
  readonly retryable: boolean;
  /** Gate for code+publicMessage vs the generic serialized shape (SI-9). */
  readonly exposeToModel: boolean;
  /** Model-safe structured data (e.g. validation issues). */
  readonly details?: unknown;
  /** Private diagnostic; NEVER serialized outward. */
  declare readonly cause?: unknown;

  constructor(options: CapabilityErrorOptions) {
    const defaults = ERROR_CODE_DEFAULTS[options.code] ?? ERROR_CODE_DEFAULTS.INTERNAL_ERROR;
    const publicMessage = options.publicMessage ?? defaults.publicMessage;
    super(`${options.code}: ${publicMessage}`, { cause: options.cause });
    this.name = "CapabilityError";
    this.code = options.code;
    this.stage = options.stage ?? defaults.stage;
    this.publicMessage = publicMessage;
    this.retryable = options.retryable ?? defaults.retryable;
    this.exposeToModel = options.exposeToModel ?? defaults.exposeToModel;
    this.details = options.details;
  }
}

export function isCapabilityError(value: unknown): value is CapabilityError {
  return value instanceof CapabilityError;
}
