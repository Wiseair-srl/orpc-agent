import type { ExposureSurface } from "../types";
import type { ApprovalCoordinator } from "../approvals/types";
import { createInMemoryApprovalCoordinator } from "../approvals/in-memory";
import { NOOP_TRACING } from "../tracing";
import { toJsonSchema } from "../schema/index";
import type { AgentGovernance } from "../governance";
import { createAuditEmitter, type AuditEmitter } from "./audit";
import { invokePipeline, resumePipeline, type PipelineDeps } from "./pipeline";
import { describePipeline } from "./describe";
import type {
  AgentRuntime,
  AgentRuntimeOptions,
  ExecutionOptions,
  ExecutionResult,
} from "./types";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLICY_TIMEOUT_MS = 5_000;
const DEFAULT_POLICY_CONCURRENCY = 16;
const DEFAULT_DISCOVERY_BUDGET_MS = 30_000;
const DEFAULT_APPROVAL_EXPIRES_IN_MS = 900_000;

const SCHEMA_CONSUMING_SURFACES: readonly ExposureSurface[] = ["aiSdk", "mcp"];

/**
 * The governed execution engine. Construction is pure and synchronous: wires
 * configuration, verifies schema convertibility for exposed schema-consuming
 * surfaces, and returns. No I/O.
 */
export function createAgentRuntime<TContext = unknown>(
  options: AgentRuntimeOptions<TContext>,
): AgentRuntime<TContext> {
  if (!options || typeof options !== "object") {
    throw new TypeError("createAgentRuntime: options are required");
  }
  if (!options.governance?.registry || !Array.isArray(options.governance.manifest)) {
    throw new TypeError(
      "createAgentRuntime: a governance is required — " +
        "createAgentRuntime({ governance: defineGovernance({ registry, policies }) })",
    );
  }

  const governance = options.governance;

  const now = options.now ?? (() => new Date());
  const audit: AuditEmitter = createAuditEmitter(options.audit);
  const coordinator =
    options.approvals?.coordinator ?? createInMemoryApprovalCoordinator({ now });

  // Startup verification, not first-call failure.
  for (const capability of governance.registry.capabilities()) {
    const exposed = SCHEMA_CONSUMING_SURFACES.some((s) => capability.meta.expose[s] === true);
    if (!exposed || !capability.inputSchema) continue;
    try {
      toJsonSchema(capability.inputSchema);
    } catch (error) {
      throw new Error(
        `createAgentRuntime: capability "${capability.id}" is exposed to a schema-consuming ` +
          `surface but its input schema is not convertible: ${(error as Error).message}`,
      );
    }
  }

  emitStartupWarnings(governance, options, audit.hasSinks);

  const deps: PipelineDeps = {
    registry: governance.registry,
    policies: [...governance.policies],
    coordinator,
    ...(options.approvals?.handler ? { inlineHandler: options.approvals.handler } : {}),
    rejectSelfApproval: options.approvals?.rejectSelfApproval ?? true,
    audit,
    tracing: options.tracing ?? NOOP_TRACING,
    defaults: {
      timeoutMs: options.defaults?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      policyTimeoutMs: options.defaults?.policyTimeoutMs ?? DEFAULT_POLICY_TIMEOUT_MS,
      policyConcurrency: options.defaults?.policyConcurrency ?? DEFAULT_POLICY_CONCURRENCY,
      discoveryBudgetMs: options.defaults?.discoveryBudgetMs ?? DEFAULT_DISCOVERY_BUDGET_MS,
      approvalExpiresInMs:
        options.defaults?.approvalExpiresInMs ?? DEFAULT_APPROVAL_EXPIRES_IN_MS,
    },
    now,
  };

  return {
    governance,
    registry: governance.registry,

    invoke<O = unknown>(
      capabilityId: string,
      input: unknown,
      invokeOptions: ExecutionOptions<TContext>,
    ): Promise<ExecutionResult<O>> {
      // Programmer errors reject; governed failures return envelopes.
      if (!invokeOptions || typeof invokeOptions !== "object") {
        throw new TypeError("invoke: options with actor and context are required");
      }
      if (typeof capabilityId !== "string" || capabilityId.length === 0) {
        throw new TypeError("invoke: capabilityId must be a non-empty string");
      }
      return invokePipeline<O>(deps, {
        capabilityId,
        rawInput: input,
        actor: invokeOptions.actor,
        context: invokeOptions.context,
        surface: invokeOptions.surface ?? "direct",
        ...(invokeOptions.signal ? { signal: invokeOptions.signal } : {}),
        ...(invokeOptions.correlationId !== undefined
          ? { correlationId: invokeOptions.correlationId }
          : {}),
      });
    },

    describe(surface, describeOptions) {
      return describePipeline(deps, surface, describeOptions);
    },

    resume<O = unknown>(
      approvalId: string,
      resumeOptions: { context: TContext; signal?: AbortSignal },
    ): Promise<ExecutionResult<O>> {
      if (typeof approvalId !== "string" || approvalId.length === 0) {
        throw new TypeError("resume: approvalId must be a non-empty string");
      }
      if (!resumeOptions || typeof resumeOptions !== "object") {
        throw new TypeError("resume: options with context are required");
      }
      return resumePipeline<O>(deps, {
        approvalId,
        context: resumeOptions.context,
        ...(resumeOptions.signal ? { signal: resumeOptions.signal } : {}),
      });
    },

    approvals: wrapCoordinator(coordinator, deps),
  };
}

const MODEL_SURFACES: readonly ExposureSurface[] = ["aiSdk", "mcp"];
const WRITE_SIDE_EFFECTS = new Set(["write", "destructive", "external"]);

/**
 * Production footgun warnings. Never fatal, and there is no flag to silence
 * them: each one fires only where a decision was left IMPLICIT, and is
 * answered by making that decision — passing the coordinator you want, or the
 * audit sink you want, including one that deliberately discards.
 *
 * A mute switch would be a second way to say the same thing, and a worse one:
 * it is global, it outlives the reason it was added, and it hides the choice
 * from whoever reads the code next. Making the choice explicit puts it where
 * a reviewer sees it.
 */
function emitStartupWarnings<TContext>(
  governance: AgentGovernance,
  options: AgentRuntimeOptions<TContext>,
  hasSinks: boolean,
): void {
  const capabilities = governance.registry.capabilities();

  // 1. Approval-gated capabilities on the (restart-amnesiac) default
  //    coordinator. An inline handler counts as an explicit choice: pure
  //    inline confirmation legitimately never persists.
  if (!options.approvals?.coordinator && !options.approvals?.handler) {
    const gated = capabilities
      .filter((c) => c.meta.approval?.required === true)
      .map((c) => c.id);
    if (gated.length > 0) {
      console.warn(
        `[orpc-agent] ${sampleIds(gated)} require approval, but no approval coordinator was ` +
          "chosen: the default is in-memory, so pending approvals will not survive a restart. " +
          "Choose one — approvals.coordinator: createPgApprovalCoordinator(…) to persist them, " +
          "or createInMemoryApprovalCoordinator() to accept the tradeoff.",
      );
    } else if (governance.policies.length > 0) {
      // 1b. The same footgun reached the other way. A policy that returns
      //     requireApproval suspends into the same coordinator, and nothing
      //     here can tell whether one does — `evaluate` needs a real actor and
      //     context. So this keys on the shape where the question is live at
      //     all: policies configured, and write-capable work a model can
      //     reach. Covering every write rather than only the irreversible ones
      //     is safe precisely because there is no mute switch: an application
      //     that does not gate answers it once, by naming the coordinator it
      //     already has, and the other warnings stay on.
      const gatable = capabilities
        .filter(
          (c) =>
            WRITE_SIDE_EFFECTS.has(c.meta.sideEffect) &&
            MODEL_SURFACES.some((s) => c.meta.expose[s] === true),
        )
        .map((c) => c.id);
      if (gatable.length > 0) {
        console.warn(
          "[orpc-agent] policies are configured and write-capable capabilities are reachable " +
            `from model surfaces (${sampleIds(gatable)}), but no approval coordinator was ` +
            "chosen. If any policy returns requireApproval, those approvals go to the default " +
            "in-memory coordinator and will not survive a restart. Choose one — " +
            "approvals.coordinator: createPgApprovalCoordinator(…) to persist them, or " +
            "createInMemoryApprovalCoordinator() to accept the tradeoff.",
        );
      }
    }
  }

  // 2. Write-capable capabilities reachable by models with nothing recording.
  if (!hasSinks) {
    const exposedWrites = capabilities
      .filter(
        (c) =>
          WRITE_SIDE_EFFECTS.has(c.meta.sideEffect) &&
          MODEL_SURFACES.some((s) => c.meta.expose[s] === true),
      )
      .map((c) => c.id);
    if (exposedWrites.length > 0) {
      console.warn(
        `[orpc-agent] ${sampleIds(exposedWrites)} are write-capable and exposed to model ` +
          "surfaces, but no audit sink was chosen: no audit trail will be stored. " +
          "Choose one — audit: createPgAuditSink(…) to record, or audit: () => {} to state " +
          "deliberately that nothing is.",
      );
    }
  }
}

function sampleIds(ids: string[]): string {
  const sample = ids
    .slice(0, 3)
    .map((id) => `"${id}"`)
    .join(", ");
  return ids.length > 3 ? `${sample} (+${ids.length - 3} more)` : sample;
}

/**
 * runtime.approvals — the configured coordinator with audit emission on
 * decisions: `decide` emits capability.approved / capability.rejected.
 * Deciding does not execute anything (the application calls `resume`).
 */
function wrapCoordinator(coordinator: ApprovalCoordinator, deps: PipelineDeps): ApprovalCoordinator {
  const wrapped: ApprovalCoordinator = {
    create: (request) => coordinator.create(request),
    get: (id) => coordinator.get(id),
    markConsumed: (id, executionId) => coordinator.markConsumed(id, executionId),
    async decide(id, decision) {
      const record = await coordinator.decide(id, decision);
      deps.audit.emit({
        type: record.status === "approved" ? "capability.approved" : "capability.rejected",
        timestamp: deps.now(),
        surface: record.surface,
        actor: { id: decision.approver.id, kind: decision.approver.kind },
        capabilityId: record.capabilityId,
        inputHash: record.inputHash,
        data: {
          approvalId: record.id,
          approver: { id: decision.approver.id, kind: decision.approver.kind },
          ...(decision.comment !== undefined ? { comment: decision.comment } : {}),
        },
      });
      return record;
    },
  };
  if (coordinator.list) {
    wrapped.list = coordinator.list.bind(coordinator);
  }
  return wrapped;
}
