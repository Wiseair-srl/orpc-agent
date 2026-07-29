import type { ExposureSurface, PolicyPhase, RiskLevel, SideEffect } from "@orpc-agent/core";

/** Written as 2; version 1 files are still read (they predate `runtime`). */
export const SNAPSHOT_VERSION = 2;

/**
 * The committed governance contract of an application. Every field is
 * deterministic: no timestamps, no generator version, no absolute paths.
 * A snapshot that churns between identical runs is a bug, not a diff.
 */
export type CapabilitySnapshot = {
  version: 1 | 2;
  /** Sorted by id. */
  capabilities: CapabilityEntry[];
  /** Procedures present in the registry defs but excluded for lacking `meta.agent`. Sorted. */
  excluded: string[];
  /** Capability ids whose expose map enables no surface at all. Sorted. */
  unexposed: string[];
  /**
   * Runtime-level governance — present only when a runtime was in scope.
   *
   * Absence and emptiness are different facts and the diff treats them
   * differently: ABSENT means no runtime was ever observed (`--entry` resolved
   * a bare registry, or the runtime came from a core too old to report), so
   * runtime policies are UNKNOWN. Present with `policies: []` means a runtime
   * was observed and it has none. A v1 file has no `runtime` key at all and
   * therefore reads as unknown, which is exactly what it was.
   */
  runtime?: RuntimeSnapshot;
};

export type RuntimeSnapshot = {
  /**
   * Runtime-level policy identity in evaluation order (NOT sorted; order
   * decides which policy is recorded as the denier and how the batch timeout
   * budget is spent). Composites are flattened, matching audit identity.
   *
   * Names and phases only. Which capabilities a policy gates, and under what
   * conditions, is not statically knowable — see the README.
   */
  policies: { name: string; phases: PolicyPhase[] }[];
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

/**
 * What `--entry` actually resolved. Only `"runtime"` puts runtime-level
 * policies in scope; the other two mean the inventory cannot speak to them,
 * for different reasons, and the output says which.
 */
export type EntrySource =
  /** A value from `defineGovernance` — the declared contract itself. */
  | "governance"
  /** An AgentRuntime carrying the governance it was built from. */
  | "runtime"
  | "registry"
  /** An AgentRuntime from a core too old to carry one. */
  | "runtime-unreported";

export type ChangeKind = "widening" | "narrowing" | "neutral";

export type Change = {
  kind: ChangeKind;
  /** Capability id, or "" for snapshot-level changes. */
  id: string;
  field: string;
  message: string;
};
