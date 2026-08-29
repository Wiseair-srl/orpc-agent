import type { Actor, ExposureSurface, RiskLevel, SideEffect } from "../types";
import type { AgentMeta } from "../meta";
import type { ApprovalRecord } from "../approvals/types";

export type PolicyPhase = "discovery" | "invocation" | "execution";

export type PolicyDecision =
  | { type: "allow"; metadata?: Record<string, unknown> }
  | { type: "deny"; code?: string; message?: string }
  | { type: "hide" }
  | {
      type: "require-approval";
      reason: string;
      approvalType?: string;
      expiresInMs?: number;
    };

export type PolicyRequest = {
  phase: PolicyPhase;
  capability: { id: string; meta: AgentMeta };
  surface: ExposureSurface;
  actor: Actor;
  /** The app context, as passed to invoke/describe. */
  context: unknown;
  /** Validated input; undefined at discovery. */
  input?: unknown;
  /** Present on resumed executions. */
  approval?: ApprovalRecord;
};

/**
 * A statically inspectable upper bound on where a policy evaluates.
 *
 * Fields compose with AND; values inside one field use ANY. For example,
 * `{ capabilities: { tags: ["billing"], sideEffects: ["write"] } }`
 * matches write capabilities carrying the billing tag. Missing scope means
 * every capability and surface. Present-but-empty arrays match nothing.
 */
export type PolicyScope = {
  capabilities?: {
    ids?: readonly string[];
    tags?: readonly string[];
    sideEffects?: readonly SideEffect[];
    risks?: readonly RiskLevel[];
  };
  surfaces?: readonly ExposureSurface[];
};

export type AgentPolicy = {
  /** Stable name, used in audit events. */
  name: string;
  /** Phases this policy evaluates in. Default: ["invocation"]. */
  phases: readonly PolicyPhase[];
  /** Authoritative applicability. The runtime skips evaluation outside it. */
  scope?: PolicyScope;
  evaluate: (req: PolicyRequest) => PolicyDecision | Promise<PolicyDecision>;
};

/**
 * The statically knowable identity and applicability of a policy — the same
 * `name` audit events record, plus phases, scope and current candidates.
 *
 * Deliberately omits `evaluate`: a decision is only meaningful inside the
 * pipeline (shared batch deadline, fail-closed on throw, audit record), so
 * handing the closure out would invite calls that look authoritative and are
 * not. What a policy decides is not knowable without a real actor and context.
 */
export type PolicyManifestEntry = {
  name: string;
  phases: readonly PolicyPhase[];
  /** Normalized selector, absent when the policy implicitly matches all. */
  scope?: PolicyScope;
  /** Current registry capabilities for which this policy can evaluate. */
  capabilities: readonly string[];
};
