import {
  createAgentRuntime,
  defineGovernance,
  createInMemoryApprovalCoordinator,
  type Actor,
  type AgentPolicy,
  type AgentRuntime,
  type ApprovalCoordinator,
  type ApprovalRecord,
  type CapabilityDescriptor,
  type CapabilityRegistry,
  type ExecutionResult,
  type ExposureSurface,
  type TracingAdapter,
} from "@orpc-agent/core";
import { capturedAudit, fakeActor, testClock, type CapturedAudit, type TestClock } from "./fakes";
import { overrideRegistry, timeoutRegistry, type HandlerOverride } from "./override-registry";

export type AgentTestRuntimeOptions<TContext = Record<string, unknown>> = {
  /** The real production registry — test what ships. */
  registry: CapabilityRegistry;
  policies?: AgentPolicy[];
  /**
   * approvalProbe-style coordinator (default: in-memory), "auto-approve" /
   * "auto-reject" inline shortcuts, or a custom coordinator.
   */
  approvals?: "auto-approve" | "auto-reject" | ApprovalCoordinator;
  /** Default actor for every call; per-call override for actor-matrix tests. */
  actor?: Actor;
  /** Default context for every call. */
  context?: TContext;
  /** Replace handlers by capability id — governance without databases. */
  overrides?: Record<string, HandlerOverride>;
  /** Drives `now` and expirations. */
  clock?: TestClock;
  /** Optional tracing adapter (e.g. for adapter conformance suites). */
  tracing?: TracingAdapter;
};

export type TestInvokeOptions<TContext> = {
  actor?: Actor;
  context?: TContext;
  surface?: ExposureSurface;
  signal?: AbortSignal;
  correlationId?: string;
  /** Test-only convenience: per-call execution timeout override. */
  timeoutMs?: number;
};

export type TestApprovals = ApprovalCoordinator & {
  pending(): Promise<ApprovalRecord[]>;
  approve(id: string, approver?: Actor): Promise<void>;
  reject(id: string, approver?: Actor): Promise<void>;
};

export type AgentTestRuntime<TContext = Record<string, unknown>> = {
  invoke<O = unknown>(
    capabilityId: string,
    input: unknown,
    options?: TestInvokeOptions<TContext>,
  ): Promise<ExecutionResult<O>>;
  describe(
    surface?: ExposureSurface,
    options?: { actor?: Actor; context?: TContext },
  ): Promise<CapabilityDescriptor[]>;
  resume<O = unknown>(
    approvalId: string,
    options?: { context?: TContext; signal?: AbortSignal },
  ): Promise<ExecutionResult<O>>;
  approvals: TestApprovals;
  audit: CapturedAudit;
  clock: TestClock;
  defaultActor: Actor;
  /** The wrapped real runtime — same pipeline, same codepaths. */
  runtime: AgentRuntime<TContext>;
};

const AUTO_APPROVER: Actor = { id: "auto-approver", kind: "automation" };
const PROBE_APPROVER: Actor = { id: "test-approver", kind: "user" };

/**
 * Wraps a real `createAgentRuntime` — same pipeline, same codepaths — with
 * fakes injected at the defined seams (`now`, coordinator, sinks, handlers).
 * It never reimplements governance.
 */
export function createAgentTestRuntime<TContext = Record<string, unknown>>(
  options: AgentTestRuntimeOptions<TContext>,
): AgentTestRuntime<TContext> {
  if (!options?.registry) {
    throw new TypeError("createAgentTestRuntime: a registry is required");
  }

  const clock = options.clock ?? testClock();
  const audit = capturedAudit();
  const defaultActor = options.actor ?? fakeActor();
  const defaultContext = (options.context ?? {}) as TContext;

  const registry = options.overrides
    ? overrideRegistry(options.registry, options.overrides)
    : options.registry;

  const coordinator: ApprovalCoordinator =
    options.approvals === "auto-approve" || options.approvals === "auto-reject" || !options.approvals
      ? createInMemoryApprovalCoordinator({ now: clock.now })
      : options.approvals;

  const approvalsConfig =
    options.approvals === "auto-approve"
      ? {
          coordinator,
          handler: async () => ({ status: "approved" as const, approver: AUTO_APPROVER }),
        }
      : options.approvals === "auto-reject"
        ? {
            coordinator,
            handler: async () => ({ status: "rejected" as const, approver: AUTO_APPROVER }),
          }
        : { coordinator };

  const makeRuntime = (reg: CapabilityRegistry) =>
    createAgentRuntime<TContext>({ governance: defineGovernance({ registry: reg, policies: options.policies ?? [] }), approvals: approvalsConfig, audit, ...(options.tracing ? { tracing: options.tracing } : {}), now: clock.now });

  const runtime = makeRuntime(registry);
  const timeoutVariants = new Map<number, AgentRuntime<TContext>>();
  const runtimeFor = (timeoutMs?: number): AgentRuntime<TContext> => {
    if (timeoutMs === undefined) return runtime;
    let variant = timeoutVariants.get(timeoutMs);
    if (!variant) {
      variant = makeRuntime(timeoutRegistry(registry, timeoutMs));
      timeoutVariants.set(timeoutMs, variant);
    }
    return variant;
  };

  const decideVia = runtime.approvals;
  const swallowExpiry = async (work: Promise<unknown>) => {
    try {
      await work;
    } catch (error) {
      if (!/expired|not pending/i.test(String((error as Error).message))) throw error;
    }
  };

  const approvals: TestApprovals = {
    create: (request) => decideVia.create(request),
    get: (id) => decideVia.get(id),
    decide: (id, decision) => decideVia.decide(id, decision),
    markConsumed: (id, executionId) => decideVia.markConsumed(id, executionId),
    ...(coordinator.list ? { list: (filter?: never) => decideVia.list!(filter) } : {}),
    pending: async () => (decideVia.list ? decideVia.list({ status: "pending" }) : []),
    approve: (id, approver = PROBE_APPROVER) =>
      swallowExpiry(decideVia.decide(id, { status: "approved", approver })),
    reject: (id, approver = PROBE_APPROVER) =>
      swallowExpiry(decideVia.decide(id, { status: "rejected", approver })),
  };

  return {
    invoke(capabilityId, input, callOptions) {
      return runtimeFor(callOptions?.timeoutMs).invoke(capabilityId, input, {
        actor: callOptions?.actor ?? defaultActor,
        context: callOptions?.context ?? defaultContext,
        surface: callOptions?.surface ?? "test",
        ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
        ...(callOptions?.correlationId !== undefined
          ? { correlationId: callOptions.correlationId }
          : {}),
      });
    },
    describe(surface = "test", callOptions) {
      return runtime.describe(surface, {
        actor: callOptions?.actor ?? defaultActor,
        context: callOptions?.context ?? defaultContext,
      });
    },
    resume(approvalId, callOptions) {
      return runtime.resume(approvalId, {
        context: callOptions?.context ?? defaultContext,
        ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
      });
    },
    approvals,
    audit,
    clock,
    defaultActor,
    runtime,
  };
}
