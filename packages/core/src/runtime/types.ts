import type { Actor, ExposureSurface, RiskLevel, SideEffect } from "../types";
import type { AgentPolicy } from "../policy/types";
import type {
  ApprovalCoordinator,
  ApprovalDecision,
  ApprovalRecord,
  ApprovalRequest,
} from "../approvals/types";
import type { AgentAuditEvent, AuditSink } from "../events";
import type { CapabilityError } from "../errors";
import type { CapabilityRegistry } from "../registry";
import type { TracingAdapter } from "../tracing";
import type { JsonSchemaObject } from "../schema/index";

export type ApprovalsConfig = {
  /** Default: createInMemoryApprovalCoordinator(). */
  coordinator?: ApprovalCoordinator;
  /**
   * Inline mode: decides in the same call instead of suspending. Returning
   * `undefined` defers the request to the coordinator (suspend/resume) flow.
   */
  handler?: (req: ApprovalRequest) => Promise<ApprovalDecision | undefined>;
  /** Default true (SI-4); disable only with a documented reason. */
  rejectSelfApproval?: boolean;
};

export type AuditConfig =
  | AuditSink
  | AuditSink[]
  | {
      sinks: AuditSink[];
      /**
       * Await the capability.started write before execution; failure aborts
       * with AUDIT_UNAVAILABLE ("no record ⇒ no execution").
       */
      strict?: boolean;
      onSinkError?: (err: unknown, event: AgentAuditEvent) => void;
    };

export type AgentRuntimeOptions<TContext> = {
  registry: CapabilityRegistry;
  /** Runtime-level, evaluated in order before meta.policies. */
  policies?: AgentPolicy[];
  approvals?: ApprovalsConfig;
  audit?: AuditConfig;
  tracing?: TracingAdapter;
  defaults?: {
    /** Per-execution ceiling. Default 30_000. */
    timeoutMs?: number;
    /** Per policy-evaluation batch. Default 5_000. */
    policyTimeoutMs?: number;
    /** Default 900_000 (15 min). */
    approvalExpiresInMs?: number;
  };
  /** Clock injection; default system clock. */
  now?: () => Date;
  /**
   * Startup footgun warnings (default true): approval-gated capabilities on
   * the default in-memory coordinator, and write-capable capabilities exposed
   * to model surfaces with no audit sink. Never fatal; `false` silences.
   */
  warnings?: boolean;
};

export type ExecutionOptions<TContext> = {
  actor: Actor;
  context: TContext;
  /** Default "direct". Adapters hardcode theirs. */
  surface?: ExposureSurface;
  signal?: AbortSignal;
  /** Threads conversation/run ids into events and traces. */
  correlationId?: string;
};

/** The normalized invocation request as the pipeline sees it. */
export type ExecutionRequest<TContext = unknown> = {
  executionId: string;
  capabilityId: string;
  surface: ExposureSurface;
  actor: Actor;
  context: TContext;
  /** Raw input as received by the runtime (pre-validation). */
  input: unknown;
  correlationId?: string;
};

export type ExecutionResult<O = unknown> =
  | { status: "completed"; executionId: string; output: O }
  | { status: "approval-required"; executionId: string; approval: ApprovalRecord }
  | { status: "failed"; executionId: string; error: CapabilityError }
  | { status: "cancelled"; executionId: string; error: CapabilityError };

export type CapabilityDescriptor = {
  id: string;
  description: string;
  inputSchema: JsonSchemaObject;
  sideEffect: SideEffect;
  risk: RiskLevel;
  tags: string[];
  /** Statically required, or discovery policies said require-approval. */
  requiresApproval?: boolean;
};

export interface AgentRuntime<TContext = unknown> {
  /** The registry this runtime executes over (adapters read meta from it). */
  readonly registry: CapabilityRegistry;

  /**
   * Runs pipeline stages 2–15. Never throws for governed failures — every
   * governed outcome returns an envelope. Rejects only on programmer error.
   */
  invoke<O = unknown>(
    capabilityId: string,
    input: unknown,
    options: ExecutionOptions<TContext>,
  ): Promise<ExecutionResult<O>>;

  /** Discovery pipeline: exposure filter → discovery-phase policies → descriptors. */
  describe(
    surface: ExposureSurface,
    options: { actor: Actor; context: TContext },
  ): Promise<CapabilityDescriptor[]>;

  /** Re-enters the pipeline at stage 8 with the approval integrity checks. */
  resume<O = unknown>(
    approvalId: string,
    options: { context: TContext; signal?: AbortSignal },
  ): Promise<ExecutionResult<O>>;

  /** The configured coordinator; `decide` emits approval audit events. */
  readonly approvals: ApprovalCoordinator;
}
