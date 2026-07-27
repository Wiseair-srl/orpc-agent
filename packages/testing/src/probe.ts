import {
  createInMemoryApprovalCoordinator,
  type Actor,
  type ApprovalCoordinator,
  type ApprovalRecord,
} from "@orpc-agent/core";

export type ApprovalProbe = ApprovalCoordinator & {
  pending(): Promise<ApprovalRecord[]>;
  approve(id: string, approver?: Actor): Promise<void>;
  reject(id: string, approver?: Actor): Promise<void>;
};

const PROBE_APPROVER: Actor = { id: "test-approver", kind: "user" };

/**
 * Standalone in-memory coordinator + test API. Pass it as a runtime's
 * coordinator (or use `createAgentTestRuntime`, which wires the equivalent
 * automatically and routes decisions through the runtime's audit emission).
 */
export function approvalProbe(options?: { now?: () => Date }): ApprovalProbe {
  const inner = createInMemoryApprovalCoordinator(options);
  return {
    create: (request) => inner.create(request),
    get: (id) => inner.get(id),
    decide: (id, decision) => inner.decide(id, decision),
    markConsumed: (id, executionId) => inner.markConsumed(id, executionId),
    list: (filter) => inner.list!(filter),
    pending: () => inner.list!({ status: "pending" }),
    async approve(id, approver = PROBE_APPROVER) {
      await inner.decide(id, { status: "approved", approver });
    },
    async reject(id, approver = PROBE_APPROVER) {
      await inner.decide(id, { status: "rejected", approver });
    },
  };
}
