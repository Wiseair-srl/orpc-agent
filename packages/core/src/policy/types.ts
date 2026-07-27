import type { Actor, ExposureSurface } from "../types";
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

export type AgentPolicy = {
  /** Stable name, used in audit events. */
  name: string;
  /** Phases this policy evaluates in. Default: ["invocation"]. */
  phases: readonly PolicyPhase[];
  evaluate: (req: PolicyRequest) => PolicyDecision | Promise<PolicyDecision>;
};
