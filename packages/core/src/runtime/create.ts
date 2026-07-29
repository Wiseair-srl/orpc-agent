import type { ExposureSurface } from "../types";
import type { ApprovalCoordinator } from "../approvals/types";
import { createInMemoryApprovalCoordinator } from "../approvals/in-memory";
import { NOOP_TRACING } from "../tracing";
import { toJsonSchema } from "../schema/index";
import { flattenPolicy } from "../policy/define";
import type { AgentPolicy, PolicyManifestEntry } from "../policy/types";
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

  if (options.warnings !== false) {
    emitStartupWarnings(options, audit.hasSinks);
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
    policies: manifestOf(deps.policies),

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
 * Composites are flattened so the reported names match the ones the pipeline
 * evaluates and audit records (`collectPolicies` does the same). Frozen: this
 * is a read of configuration, not a handle on it.
 */
function manifestOf(policies: AgentPolicy[]): readonly PolicyManifestEntry[] {
  return Object.freeze(
    policies
      .flatMap(flattenPolicy)
      .map((policy) => Object.freeze({ name: policy.name, phases: Object.freeze([...policy.phases]) })),
  );
}

const MODEL_SURFACES: readonly ExposureSurface[] = ["aiSdk", "mcp"];
const WRITE_SIDE_EFFECTS = new Set(["write", "destructive", "external"]);
/** Where losing a pending approval on restart is not recoverable by retrying. */
const IRREVERSIBLE_SIDE_EFFECTS = new Set(["destructive", "external"]);

/**
 * Production footgun warnings (never fatal; `warnings: false` silences).
 * Static knowledge only: what a policy decides needs a real invocation, so
 * condition 1 keys on meta.approval.required and 1b on the shape that makes a
 * policy-driven gate likely.
 */
function emitStartupWarnings<TContext>(
  options: AgentRuntimeOptions<TContext>,
  hasSinks: boolean,
): void {
  const capabilities = options.registry.capabilities();

  // 1. Approval-gated capabilities on the (restart-amnesiac) default
  //    coordinator. An inline handler counts as an explicit choice: pure
  //    inline confirmation legitimately never persists.
  if (!options.approvals?.coordinator && !options.approvals?.handler) {
    const gated = capabilities
      .filter((c) => c.meta.approval?.required === true)
      .map((c) => c.id);
    if (gated.length > 0) {
      console.warn(
        `[orpc-agent] ${sampleIds(gated)} require approval but the runtime is using the ` +
          "default in-memory coordinator: approval records will not survive restarts. " +
          "Pass approvals.coordinator (e.g. @orpc-agent/postgres), or set warnings: false.",
      );
    } else if ((options.policies ?? []).length > 0) {
      // 1b. The same footgun reached the other way. A policy that returns
      //     requireApproval suspends into the same amnesiac coordinator, and
      //     nothing here can tell whether one does. Deliberately narrower than
      //     condition 2: only destructive/external work a model can reach, not
      //     every write. A rate-limit policy over ordinary writes is the
      //     common case and must not cost a warning, or all three stop being
      //     read.
      const gatable = capabilities
        .filter(
          (c) =>
            IRREVERSIBLE_SIDE_EFFECTS.has(c.meta.sideEffect) &&
            MODEL_SURFACES.some((s) => c.meta.expose[s] === true),
        )
        .map((c) => c.id);
      if (gatable.length > 0) {
        console.warn(
          "[orpc-agent] runtime policies are configured and write-capable capabilities are " +
            `reachable from model surfaces (${sampleIds(gatable)}). If any policy returns ` +
            "requireApproval, those approvals go to the default in-memory coordinator and will " +
            "not survive restarts. Pass approvals.coordinator (e.g. @orpc-agent/postgres), or " +
            "set warnings: false.",
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
          "surfaces with no audit sink configured: no audit trail will be stored. " +
          "Configure audit sinks (e.g. @orpc-agent/postgres), or set warnings: false.",
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
