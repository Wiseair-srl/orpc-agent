import type { ExposureSurface, RiskLevel, SideEffect } from "@orpc-agent/core";

/**
 * The committed governance contract of an application. Every field is
 * deterministic: no timestamps, no generator version, no absolute paths.
 * A snapshot that churns between identical runs is a bug, not a diff.
 */
export type CapabilitySnapshot = {
  version: 1;
  /** Sorted by id. */
  capabilities: CapabilityEntry[];
  /** Procedures present in the registry defs but excluded for lacking `meta.agent`. Sorted. */
  excluded: string[];
  /** Capability ids whose expose map enables no surface at all. Sorted. */
  unexposed: string[];
};

export type CapabilityEntry = {
  id: string;
  /** Model-facing text. Omitted when built with `descriptions: false`. */
  description?: string;
  sideEffect: SideEffect;
  risk: RiskLevel;
  /** Only surfaces whose expose value is exactly `true`. Sorted. */
  expose: ExposureSurface[];
  /**
   * Meta-derived protocol names, per exposed schema-consuming surface.
   * An adapter configured with its own `toolNaming` option overrides these —
   * that override is invisible here (see README, "What this does not see").
   */
  toolNames?: { [surface: string]: string };
  approval?: { required: boolean; type?: string; expiresInMs?: number };
  idempotent: boolean;
  /** `retryOn` is a function: only its presence is recorded. */
  retry?: { maxAttempts: number; backoffMs?: number; retryOn: boolean };
  timeoutMs?: number;
  /** Sorted — tags are a set (the registry matches them with any-of). */
  tags: string[];
  /**
   * Policy names in declaration order, NOT sorted: evaluation order decides
   * which policy is recorded as the denier and how the batch timeout budget
   * is spent. Composite policies appear under their composite name.
   */
  policies: string[];
  /** Redaction hooks are functions: only presence is recorded. */
  redact?: { output: boolean; approvalInput: boolean };
  /**
   * sha256 of the canonical JSON Schema of the input, or `null` when the
   * capability takes no input. `"unconvertible"` when the schema has no
   * registered converter — a real state, and a transition into or out of it
   * is real drift.
   */
  inputSchemaHash: string | null | "unconvertible";
};

export type ChangeKind = "widening" | "narrowing" | "neutral";

export type Change = {
  kind: ChangeKind;
  /** Capability id, or "" for snapshot-level changes. */
  id: string;
  field: string;
  message: string;
};
