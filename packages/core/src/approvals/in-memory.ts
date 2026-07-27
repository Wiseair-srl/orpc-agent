import { isWellFormedActor } from "../types";
import type {
  ApprovalCoordinator,
  ApprovalDecision,
  ApprovalRecord,
  ApprovalRequest,
  ApprovalStatus,
} from "./types";

/**
 * Process-local Map-backed coordinator for development and tests. Records do
 * not survive restarts — production deployments implement ApprovalCoordinator
 * over their own storage (ADR-007).
 */
export function createInMemoryApprovalCoordinator(options?: {
  now?: () => Date;
}): ApprovalCoordinator {
  const now = options?.now ?? (() => new Date());
  const records = new Map<string, ApprovalRecord>();

  function mustGet(id: string): ApprovalRecord {
    const record = records.get(id);
    if (!record) throw new Error(`Approval "${id}" was not found`);
    return record;
  }

  return {
    async create(request: ApprovalRequest): Promise<ApprovalRecord> {
      if (records.has(request.id)) {
        throw new Error(`Approval "${request.id}" already exists`);
      }
      const record: ApprovalRecord = { ...request, status: "pending" };
      records.set(request.id, record);
      return { ...record };
    },

    async get(id: string): Promise<ApprovalRecord | null> {
      const record = records.get(id);
      if (!record) return null;
      if (record.status === "pending" && now().getTime() > record.expiresAt.getTime()) {
        record.status = "expired";
      }
      return { ...record };
    },

    async decide(id: string, decision: ApprovalDecision): Promise<ApprovalRecord> {
      const record = mustGet(id);
      if (decision.status !== "approved" && decision.status !== "rejected") {
        throw new Error(`Invalid decision status "${String(decision.status)}"`);
      }
      if (!isWellFormedActor(decision.approver)) {
        throw new Error("Decision approver must be a well-formed actor");
      }
      if (record.status === "pending" && now().getTime() > record.expiresAt.getTime()) {
        record.status = "expired";
      }
      if (record.status !== "pending") {
        throw new Error(`Approval "${id}" is not pending (status: ${record.status})`);
      }
      record.status = decision.status;
      record.decision = { ...decision, decidedAt: now() };
      return { ...record };
    },

    async markConsumed(id: string, executionId: string): Promise<ApprovalRecord> {
      const record = mustGet(id);
      // Check-and-set with no interleaved awaits — atomic per coordinator.
      if (record.status !== "approved" || record.consumedByExecutionId !== undefined) {
        throw new Error(
          `Approval "${id}" cannot be consumed (status: ${record.status}${
            record.consumedByExecutionId ? `, consumed by ${record.consumedByExecutionId}` : ""
          })`,
        );
      }
      record.status = "consumed";
      record.consumedByExecutionId = executionId;
      return { ...record };
    },

    async list(filter?: {
      status?: ApprovalStatus;
      capabilityId?: string;
      actorId?: string;
    }): Promise<ApprovalRecord[]> {
      const all = [...records.values()];
      for (const record of all) {
        if (record.status === "pending" && now().getTime() > record.expiresAt.getTime()) {
          record.status = "expired";
        }
      }
      return all
        .filter((r) => filter?.status === undefined || r.status === filter.status)
        .filter((r) => filter?.capabilityId === undefined || r.capabilityId === filter.capabilityId)
        .filter((r) => filter?.actorId === undefined || r.actor.id === filter.actorId)
        .map((r) => ({ ...r }));
    },
  };
}
