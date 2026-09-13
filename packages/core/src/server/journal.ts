import type { CapabilityOutcome, InvocationReceipt } from "../client/index";

/** Server-only row; scope is derived from authenticated namespace + actor + surface. */
export type InvocationRecord = InvocationReceipt & {
  scope: string;
  inputHash: string;
  /** Original JSON input, private; permits resource authorization on receipt reads. */
  input: unknown;
  idempotencyKey: string;
  claimToken: string;
};
export interface InvocationJournal {
  get(scope: string, invocationId: string): Promise<InvocationRecord | null>;
  findApproval(scope: string, approvalId: string): Promise<InvocationRecord | null>;
  /** Atomic insert-if-absent. Never steal/retry a pending operation. */
  claim(record: InvocationRecord): Promise<{ claimed: boolean; record: InvocationRecord }>;
  /** Atomic transition from the matching approval-required outcome to pending. */
  claimResume(scope: string, invocationId: string, approvalId: string, claimToken: string): Promise<boolean>;
  /** Compare-and-set against the owner token. Throws if ownership was lost. */
  settle(scope: string, invocationId: string, claimToken: string, outcome: CapabilityOutcome): Promise<void>;
}
/** Development only. Restart loses receipts; explicitly select Postgres in production. */
export function createInMemoryInvocationJournal(): InvocationJournal {
  const records = new Map<string, InvocationRecord>();
  const key = (scope: string, id: string) => JSON.stringify([scope, id]);
  return {
    async get(scope, id) { return structuredClone(records.get(key(scope, id)) ?? null); },
    async findApproval(scope, approvalId) {
      return structuredClone([...records.values()].find((r) => r.scope === scope && r.approvalId === approvalId) ?? null);
    },
    async claim(record) {
      const previous = records.get(key(record.scope, record.invocationId));
      if (previous) return { claimed: false, record: structuredClone(previous) };
      records.set(key(record.scope, record.invocationId), structuredClone(record));
      return { claimed: true, record: structuredClone(record) };
    },
    async claimResume(scope, id, approvalId, claimToken) {
      const record = records.get(key(scope, id));
      if (record?.state !== "settled" || record.outcome?.status !== "approval-required" || record.approvalId !== approvalId) return false;
      record.state = "pending";
      record.claimToken = claimToken;
      record.updatedAt = new Date().toISOString();
      delete record.outcome;
      return true;
    },
    async settle(scope, id, claimToken, outcome) {
      const record = records.get(key(scope, id));
      if (!record || record.state !== "pending" || record.claimToken !== claimToken) throw new Error("Invocation ownership lost");
      record.state = "settled";
      record.outcome = structuredClone(outcome);
      record.updatedAt = new Date().toISOString();
      if (outcome.status === "approval-required") record.approvalId = outcome.approval.id;
    },
  };
}
