import type { Actor, ExposureSurface, RiskLevel, SideEffect } from "../types";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "cancelled"
  | "consumed";

export type ApprovalRequest = {
  id: string;
  capabilityId: string;
  surface: ExposureSurface;
  /** The requester. */
  actor: Actor;
  /** Validated input (stored for resumption). */
  input: unknown;
  /** sha256 of canonical JSON of the validated input (SI-5). */
  inputHash: string;
  /** Merged from policies / static meta. */
  reasons: string[];
  /** Merged approvalTypes. */
  types: string[];
  risk: RiskLevel;
  sideEffect: SideEffect;
  requestedAt: Date;
  expiresAt: Date;
};

export type ApprovalDecision = {
  status: "approved" | "rejected";
  approver: Actor;
  comment?: string;
};

export type ApprovalRecord = ApprovalRequest & {
  status: ApprovalStatus;
  decision?: ApprovalDecision & { decidedAt: Date };
  consumedByExecutionId?: string;
};

export interface ApprovalCoordinator {
  create(request: ApprovalRequest): Promise<ApprovalRecord>;
  get(id: string): Promise<ApprovalRecord | null>;
  /** Throws unless pending & unexpired. */
  decide(id: string, decision: ApprovalDecision): Promise<ApprovalRecord>;
  /** Atomic; throws if already consumed (or not approved). */
  markConsumed(id: string, executionId: string): Promise<ApprovalRecord>;
  list?(filter?: {
    status?: ApprovalStatus;
    capabilityId?: string;
    actorId?: string;
  }): Promise<ApprovalRecord[]>;
}
