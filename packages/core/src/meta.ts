import type { ExposureSurface, RedactionInfo, RiskLevel, SideEffect } from "./types";
import type { AgentPolicy } from "./policy/types";
import type { CapabilityError } from "./errors";

/**
 * The declaration that turns an oRPC procedure into a capability. Lives in the
 * procedure's ordinary oRPC metadata under the `agent` key; validated when
 * `createCapabilityRegistry` builds the registry.
 * Contract: docs/reference/metadata.md.
 */
export type AgentMeta = {
  /** Model-facing explanation of what the capability does and when to use it. Required. */
  description: string;

  /** Deny-by-default exposure per surface. Only `true` exposes. Required (SI-1). */
  expose: Partial<Record<ExposureSurface, boolean>>;

  /** What the capability does to the world. Required. Never inferred. */
  sideEffect: SideEffect;

  /** Sensitivity of the operation, independent of sideEffect. Required. Never inferred. */
  risk: RiskLevel;

  /** Model presentation only; contextual capabilities remain governed and invocable. */
  discovery?: "discoverable" | "contextual";

  /** Free-form labels for filtering and policy targeting. */
  tags?: string[];

  /** Per-capability execution timeout. Default: runtime `defaults.timeoutMs`. */
  timeoutMs?: number;

  /** Runtime-managed retries. Only effective under the eligibility rules (SI-11). */
  retry?: {
    /** Additional attempts after the first. */
    maxAttempts: number;
    /** Base delay, exponential; default 250. */
    backoffMs?: number;
    /** Extra predicate over `retryable` errors. */
    retryOn?: (error: CapabilityError) => boolean;
  };

  /**
   * Declares that repeating the operation with the same input is safe.
   * Required (with retry config) before the runtime will retry a write.
   */
  idempotent?: boolean;

  /** Static approval gate. Conditional approval belongs in policies. */
  approval?: {
    required?: boolean;
    type?: string;
    /** Default: runtime defaults.approvalExpiresInMs. */
    expiresInMs?: number;
  };

  /**
   * Redaction hooks. Both receive a frozen `RedactionInfo` (surface,
   * capabilityId, actor, context) as a second argument, so one capability can
   * redact on one surface and pass through on another; one-argument hooks
   * keep working. Must be pure and total: a throw fails closed.
   */
  redact?: {
    /** Maps validated output to its model-safe form. Applied by the runtime at stage 13. */
    output?: (output: unknown, info: RedactionInfo) => unknown;
    /**
     * Maps the stored input to what approval surfaces may display. Applied by
     * the application through `redactApprovalInput`; the hash binds the full input.
     */
    approvalInput?: (input: unknown, info: RedactionInfo) => unknown;
  };

  /** Capability-scoped policies, evaluated after runtime-level policies. */
  policies?: AgentPolicy[];

  /** Adapter-specific overrides. Never affects governance. */
  adapters?: {
    aiSdk?: { toolName?: string };
    mcp?: { toolName?: string; annotations?: Record<string, unknown> };
  };
};
