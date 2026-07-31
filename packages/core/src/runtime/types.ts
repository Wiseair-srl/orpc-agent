import type { Actor, ExposureSurface, RiskLevel, SideEffect } from "../types";
import type { AgentPolicy, PolicyManifestEntry } from "../policy/types";
import type { AgentGovernance } from "../governance";
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
      /**
       * Adds the payloads whose size grows with the catalog — today, the id
       * list on capabilities.discovered. Off by default: a routine event
       * carrying an unbounded array is forwarded, stored, and re-sent on every
       * discovery (ADR-017).
       */
      verbose?: boolean;
      onSinkError?: (err: unknown, event: AgentAuditEvent) => void;
    };

export type AgentRuntimeOptions<TContext = unknown> = {
  /**
   * The governed surface — what an agent may reach, and what is evaluated
   * before it does. Declared with `defineGovernance`, which is the only way
   * to build one: a runtime that took a registry and a policy list directly
   * could evaluate a list no exported value names, and tooling would have
   * nothing to check against.
   */
  governance: AgentGovernance;

  approvals?: ApprovalsConfig;
  audit?: AuditConfig;
  tracing?: TracingAdapter;
  defaults?: {
    /** Per-execution ceiling. Default 30_000. */
    timeoutMs?: number;
    /** Per policy-evaluation batch. Default 5_000. */
    policyTimeoutMs?: number;
    /**
     * How many capabilities' discovery-phase policy batches evaluate at once.
     * Default 16. Within one capability, policies still evaluate in order
     * against their shared batch deadline.
     */
    policyConcurrency?: number;
    /**
     * Ceiling on a whole `describe`, not on one capability's batch. Default
     * 30_000. On expiry `describe` throws TIMEOUT rather than returning a
     * short catalog (ADR-017).
     */
    discoveryBudgetMs?: number;
    /** Default 900_000 (15 min). */
    approvalExpiresInMs?: number;
  };
  /** Clock injection; default system clock. */
  now?: () => Date;
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

/**
 * Discovery shaping only, never an authority boundary (SI-2): `invoke` does
 * not consult it, so a capability left out of a scoped `describe` remains
 * fully invocable by an authorized actor. Use exposure or a policy to make
 * one unreachable.
 *
 * `tags` matches capabilities carrying ANY listed tag; `ids` selects exactly;
 * given both, the result is their union. A capability with no tags never
 * matches a `tags` scope. An object carrying neither key does not narrow —
 * same as omitting `scope`.
 */
export type DescribeScope = {
  tags?: string[];
  ids?: string[];
};

export type DescribeOptions<TContext = unknown> = {
  actor: Actor;
  context: TContext;
  /** Applied after the exposure filter and BEFORE any policy runs. */
  scope?: DescribeScope;
};

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
  /**
   * The governed surface this runtime executes. `governance.manifest` carries
   * the runtime-level policy identity — the configuration, not its effect: a
   * decision depends on the actor, surface, input and context of a real
   * invocation, so tooling may report that these policies exist but may not
   * conclude which capabilities they gate.
   */
  readonly governance: AgentGovernance;

  /** Shorthand for `governance.registry` — adapters read capability meta from it. */
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

  /**
   * Discovery pipeline: exposure filter → scope filter → discovery-phase
   * policies → descriptors. Throws TIMEOUT if the discovery budget expires;
   * a short catalog would be indistinguishable from lost access.
   */
  describe(
    surface: ExposureSurface,
    options: DescribeOptions<TContext>,
  ): Promise<CapabilityDescriptor[]>;

  /** Re-enters the pipeline at stage 8 with the approval integrity checks. */
  resume<O = unknown>(
    approvalId: string,
    options: { context: TContext; signal?: AbortSignal },
  ): Promise<ExecutionResult<O>>;

  /** The configured coordinator; `decide` emits approval audit events. */
  readonly approvals: ApprovalCoordinator;
}
