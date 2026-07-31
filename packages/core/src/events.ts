import type { Actor, ExposureSurface, RiskLevel, SideEffect } from "./types";
import type { ErrorCode, FailureStage } from "./errors";
import type { PolicyDecision } from "./policy/types";

/**
 * Structured audit events (ADR-010). Raw inputs and outputs are never
 * included (SI-10); events carry identities, classifications, hashes,
 * decisions, and durations. Contract: docs/reference/events.md.
 */

export type AuditActorRef = { id: string; kind: Actor["kind"] };

type AuditEnvelope = {
  timestamp: Date;
  surface: ExposureSurface;
  /** Attributes stripped by default. */
  actor: AuditActorRef;
  /** Absent on capabilities.discovered (and coordinator decisions). */
  executionId?: string;
  capabilityId?: string;
  correlationId?: string;
  /** Present from stage 5 onward (when the validated input is hashable). */
  inputHash?: string;
};

export type DeniedReason =
  | "unknown"
  | "not-exposed"
  | "hidden"
  | "policy-denied"
  | "policy-failed";

/**
 * Every evaluated policy's stance. `"error"` marks a policy that threw or
 * timed out (fail-closed, SI-7).
 */
export type PolicyDecisionRecord = {
  policy: string;
  type: PolicyDecision["type"] | "error";
};

export type AgentAuditEvent =
  | (AuditEnvelope & {
      type: "capabilities.discovered";
      /** Constant-size by default — the payload must not grow with the catalog (ADR-017). */
      data: {
        count: number;
        surface: ExposureSurface;
        /**
         * Digest of the sorted id list: equal digests ⇒ equal catalogs, which
         * answers "did this actor's visible surface change" without carrying
         * it. The algorithm is NOT part of the contract — compare digests,
         * never reconstruct or store one as an identifier.
         */
        digest: string;
        /** Only at the verbose audit level (`audit: { verbose: true }`). */
        capabilityIds?: string[];
      };
    })
  | (AuditEnvelope & {
      type: "capability.requested";
      data: { sideEffect?: SideEffect; risk?: RiskLevel };
    })
  | (AuditEnvelope & {
      type: "capability.denied";
      data: {
        /** The TRUE reason — concealment applies to clients, never to audit (SI-8). */
        reason: DeniedReason;
        /** The externally visible error code. */
        publicCode: ErrorCode;
        policyDecisions?: PolicyDecisionRecord[];
      };
    })
  | (AuditEnvelope & {
      type: "capability.approval_requested";
      data: { approvalId: string; reasons: string[]; types: string[]; expiresAt: Date };
    })
  | (AuditEnvelope & {
      type: "capability.approved";
      data: { approvalId: string; approver: AuditActorRef; comment?: string };
    })
  | (AuditEnvelope & {
      type: "capability.rejected";
      data: { approvalId: string; approver: AuditActorRef; comment?: string };
    })
  | (AuditEnvelope & {
      type: "capability.started";
      data: { attempt: number; approvalId?: string };
    })
  | (AuditEnvelope & {
      type: "capability.retried";
      data: { attempt: number; previousErrorCode: ErrorCode };
    })
  | (AuditEnvelope & {
      type: "capability.completed";
      data: { durationMs: number; attempts: number };
    })
  | (AuditEnvelope & {
      type: "capability.failed";
      data: {
        code: ErrorCode;
        stage: FailureStage;
        retryable: boolean;
        attempts: number;
        /** True when the procedure ran before the failure (stages 12–13). */
        executedBeforeFailure?: boolean;
        policyDecisions?: PolicyDecisionRecord[];
      };
    })
  | (AuditEnvelope & {
      type: "capability.cancelled";
      data: { code: "TIMEOUT" | "CANCELLED"; durationMs: number };
    });

export type AgentAuditEventType = AgentAuditEvent["type"];

export type AuditSink = (event: AgentAuditEvent) => void | Promise<void>;
