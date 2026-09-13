import type { ApprovalStatus } from "../approvals/types";
import type { CapabilityDescriptor, DescribeScope } from "../runtime/types";

/** Versioned, serializable model contract. Model outputs are opaque after redaction. */
export type PortableCapabilityDescriptor = CapabilityDescriptor & {
  version: 1;
  path: string[];
  toolNames: { aiSdk: string; mcp: string };
  discovery: "discoverable" | "contextual";
  contractDigest: string;
};
export type PortableApproval = {
  id: string;
  capabilityId: string;
  status: ApprovalStatus;
  reasons: string[];
  types: string[];
  requestedAt: string;
  expiresAt: string;
};
export type PublicCapabilityError = { code: string; message: string; retryable: boolean; details?: unknown };
export type CapabilityOutcome = { invocationId: string } & (
  | { status: "completed"; executionId: string; output: unknown }
  | { status: "approval-required"; executionId: string; approval: PortableApproval }
  | { status: "failed" | "cancelled"; executionId: string; error: PublicCapabilityError }
  | { status: "outcome-unknown" }
);
export type InvocationOptions = {
  /** Persist before dispatch. Reuse for transport retry and approval resumption. */
  invocationId: string;
  correlationId?: string;
  contractDigest?: string;
  signal?: AbortSignal;
};
export type InvocationReceipt = {
  invocationId: string;
  capabilityId: string;
  contractDigest: string;
  correlationId?: string;
  state: "pending" | "settled";
  outcome?: CapabilityOutcome;
  approvalId?: string;
  createdAt: string;
  updatedAt: string;
};
export interface CapabilityClient {
  describe(options?: { scope?: DescribeScope }): Promise<PortableCapabilityDescriptor[]>;
  invoke(capabilityId: string, input: unknown, options: InvocationOptions): Promise<CapabilityOutcome>;
  getInvocation(invocationId: string): Promise<InvocationReceipt | null>;
  getApproval(approvalId: string): Promise<PortableApproval | null>;
  resumeApproval(approvalId: string, options: InvocationOptions): Promise<CapabilityOutcome>;
}
export type CapabilityInvokeRequest = Omit<InvocationOptions, "signal"> & { capabilityId: string; input: unknown };
export type CapabilityResumeRequest = Omit<InvocationOptions, "signal"> & { approvalId: string };
/** Structural oRPC client. No backend router, runtime, Zod, or Node imports. */
export type CapabilityRPCClient = {
  describe(input: { scope?: DescribeScope }): Promise<PortableCapabilityDescriptor[]>;
  invoke(input: CapabilityInvokeRequest, options?: { signal?: AbortSignal }): Promise<CapabilityOutcome>;
  getInvocation(input: { invocationId: string }): Promise<InvocationReceipt | null>;
  getApproval(input: { approvalId: string }): Promise<PortableApproval | null>;
  resumeApproval(input: CapabilityResumeRequest, options?: { signal?: AbortSignal }): Promise<CapabilityOutcome>;
}
export function createCapabilityClient({ rpc }: { rpc: CapabilityRPCClient }): CapabilityClient {
  return {
    describe: (options = {}) => rpc.describe(options),
    async invoke(capabilityId, input, { signal, ...options }) {
      try { return await rpc.invoke({ capabilityId, input, ...options }, { signal }); }
      catch (error) { return transportOutcome(error, options.invocationId); }
    },
    getInvocation: (invocationId) => rpc.getInvocation({ invocationId }),
    getApproval: (approvalId) => rpc.getApproval({ approvalId }),
    async resumeApproval(approvalId, { signal, ...options }) {
      try { return await rpc.resumeApproval({ approvalId, ...options }, { signal }); }
      catch (error) { return transportOutcome(error, options.invocationId); }
    },
  };
}

function transportOutcome(error: unknown, invocationId: string): CapabilityOutcome {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  const preflight = code === "UNAUTHORIZED" ? { code: "UNAUTHENTICATED", message: "Authentication is required." }
    : code === "FORBIDDEN" ? { code: "FORBIDDEN", message: "The operation is not permitted." }
    : code === "BAD_REQUEST" ? { code: "INPUT_INVALID", message: "Invalid capability gateway request." } : undefined;
  if (preflight) return { status: "failed", executionId: "", invocationId, error: { ...preflight, retryable: false } };
  return { status: "outcome-unknown", invocationId };
}
