// ---- Capability model ----
export { agentProcedure } from "./procedure";
export { createCapabilityRegistry } from "./registry";
export type {
  AgentCapability,
  CapabilityDefs,
  CapabilityQuery,
  CapabilityRegistry,
} from "./registry";
export type { AgentMeta } from "./meta";
export type {
  Actor,
  AgentInvocationInfo,
  ExposureSurface,
  RiskLevel,
  SideEffect,
} from "./types";

// ---- Policies ----
export { composePolicies, definePolicy } from "./policy/define";
export { allow, deny, hide, requireApproval } from "./policy/helpers";
export type {
  AgentPolicy,
  PolicyDecision,
  PolicyPhase,
  PolicyRequest,
} from "./policy/types";

// ---- Approvals ----
export { createInMemoryApprovalCoordinator } from "./approvals/in-memory";
export type {
  ApprovalCoordinator,
  ApprovalDecision,
  ApprovalRecord,
  ApprovalRequest,
  ApprovalStatus,
} from "./approvals/types";

// ---- Runtime ----
export { createAgentRuntime } from "./runtime/create";
export { unwrap } from "./unwrap";
export type {
  AgentRuntime,
  AgentRuntimeOptions,
  ApprovalsConfig,
  AuditConfig,
  CapabilityDescriptor,
  ExecutionOptions,
  ExecutionRequest,
  ExecutionResult,
} from "./runtime/types";

// ---- Errors ----
export { CapabilityError } from "./errors";
export type { CapabilityErrorOptions, ErrorCode, FailureStage } from "./errors";

// ---- Events and tracing ----
export type {
  AgentAuditEvent,
  AgentAuditEventType,
  AuditActorRef,
  AuditSink,
  DeniedReason,
  PolicyDecisionRecord,
} from "./events";
export type { SpanAttributes, SpanHandle, TracingAdapter } from "./tracing";
