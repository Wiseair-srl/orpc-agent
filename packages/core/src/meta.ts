import type { ExposureSurface, RiskLevel, SideEffect } from "./types";
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

  /** Redaction hooks. Applied per the pipeline (stages 8 and 13). */
  redact?: {
    /** Maps validated output to its model-safe form before adapter serialization. */
    output?: (output: unknown) => unknown;
    /** Maps validated input to what approval UIs may display. */
    approvalInput?: (input: unknown) => unknown;
  };

  /** Capability-scoped policies, evaluated after runtime-level policies. */
  policies?: AgentPolicy[];

  /** Adapter-specific overrides. Never affects governance. */
  adapters?: {
    aiSdk?: { toolName?: string };
    mcp?: { toolName?: string; annotations?: Record<string, unknown> };
  };
};
