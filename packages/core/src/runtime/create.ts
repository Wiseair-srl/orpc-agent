import type { ExposureSurface } from "../types";
import type { ApprovalCoordinator } from "../approvals/types";
import { createInMemoryApprovalCoordinator } from "../approvals/in-memory";
import { NOOP_TRACING } from "../tracing";
import { toJsonSchema } from "../schema/index";
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
  if (!options.registry || typeof options.registry.get !== "function") {
    throw new TypeError("createAgentRuntime: a capability registry is required");
  }

  const now = options.now ?? (() => new Date());
  const audit: AuditEmitter = createAuditEmitter(options.audit);
  const coordinator =
    options.approvals?.coordinator ?? createInMemoryApprovalCoordinator({ now });

  // Startup verification, not first-call failure.
  for (const capability of options.registry.capabilities()) {
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

  const deps: PipelineDeps = {
    registry: options.registry,
    policies: options.policies ?? [],
    coordinator,
    ...(options.approvals?.handler ? { inlineHandler: options.approvals.handler } : {}),
    rejectSelfApproval: options.approvals?.rejectSelfApproval ?? true,
    audit,
    tracing: options.tracing ?? NOOP_TRACING,
    defaults: {
      timeoutMs: options.defaults?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      policyTimeoutMs: options.defaults?.policyTimeoutMs ?? DEFAULT_POLICY_TIMEOUT_MS,
      approvalExpiresInMs:
        options.defaults?.approvalExpiresInMs ?? DEFAULT_APPROVAL_EXPIRES_IN_MS,
    },
    now,
  };

  return {
    registry: options.registry,

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
