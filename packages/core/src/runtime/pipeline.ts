import { call, type AnyProcedure } from "@orpc/server";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { CapabilityError, type ErrorCode } from "../errors";
import { isWellFormedActor, type Actor, type ExposureSurface } from "../types";
import type { AgentCapability, CapabilityRegistry } from "../registry";
import type { AgentPolicy, PolicyRequest } from "../policy/types";
import type {
  ApprovalCoordinator,
  ApprovalDecision,
  ApprovalRecord,
  ApprovalRequest,
} from "../approvals/types";
import type { AgentAuditEvent, DeniedReason, PolicyDecisionRecord } from "../events";
import type { SpanHandle, TracingAdapter } from "../tracing";
import type { AuditEmitter } from "./audit";
import type { ExecutionResult } from "./types";
import { canonicalJson, hashInput } from "../canonical";
import { createCompositeSignal, delay } from "./signals";
import { normalizeExecutionError, summarizeIssues } from "./normalize-error";
import {
  collectPolicies,
  evaluatePolicies,
  type PolicyEvaluationOutcome,
  type RequireApprovalDecision,
} from "./policies";

export type PipelineDeps = {
  registry: CapabilityRegistry;
  policies: AgentPolicy[];
  coordinator: ApprovalCoordinator;
  inlineHandler?: (req: ApprovalRequest) => Promise<ApprovalDecision | undefined>;
  rejectSelfApproval: boolean;
  audit: AuditEmitter;
  tracing: TracingAdapter;
  defaults: {
    timeoutMs: number;
    policyTimeoutMs: number;
    policyConcurrency: number;
    discoveryBudgetMs: number;
    approvalExpiresInMs: number;
  };
  now: () => Date;
};

export type InvokeArgs = {
  capabilityId: string;
  rawInput: unknown;
  actor: Actor;
  context: unknown;
  surface: ExposureSurface;
  signal?: AbortSignal;
  correlationId?: string;
};

export type ResumeArgs = {
  approvalId: string;
  context: unknown;
  signal?: AbortSignal;
};

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

/** Everything the shared stage 9–15 executor needs. */
type ExecutionFrame = {
  deps: PipelineDeps;
  executionId: string;
  capability: AgentCapability;
  actor: Actor;
  context: unknown;
  surface: ExposureSurface;
  /** Validated input (SI-6) — what policies and hashes see. */
  validatedInput: unknown;
  /** What is handed to the oRPC call (raw on fresh invocations, stored on resume). */
  inputForCall: unknown;
  inputHash: string | undefined;
  callerSignal: AbortSignal | undefined;
  correlationId: string | undefined;
  approval?: { id: string; approver: Actor; record?: ApprovalRecord };
  span: SpanHandle;
  startedAt: Date;
  /** Records of every policy evaluated so far (stage 7 and 9). */
  policyRecords: PolicyDecisionRecord[];
};

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------

type EnvelopeBase = {
  timestamp: Date;
  surface: ExposureSurface;
  actor: { id: string; kind: Actor["kind"] };
  executionId?: string;
  capabilityId?: string;
  correlationId?: string;
  inputHash?: string;
};

function envelope(frame: {
  deps: PipelineDeps;
  surface: ExposureSurface;
  actor: Actor;
  executionId?: string;
  capabilityId?: string;
  capability?: AgentCapability;
  correlationId?: string;
  inputHash?: string;
}): EnvelopeBase {
  const actor = frame.actor as Partial<Actor> | undefined;
  const capabilityId = frame.capabilityId ?? frame.capability?.id;
  const base: EnvelopeBase = {
    timestamp: frame.deps.now(),
    surface: frame.surface,
    actor: {
      id: typeof actor?.id === "string" ? actor.id : "unknown",
      kind: isWellFormedActor(actor) ? actor.kind : "anonymous",
    },
  };
  if (frame.executionId !== undefined) base.executionId = frame.executionId;
  if (capabilityId !== undefined) base.capabilityId = capabilityId;
  if (frame.correlationId !== undefined) base.correlationId = frame.correlationId;
  if (frame.inputHash !== undefined) base.inputHash = frame.inputHash;
  return base;
}

function durationMs(frame: { deps: PipelineDeps; startedAt: Date }): number {
  return Math.max(0, frame.deps.now().getTime() - frame.startedAt.getTime());
}

// ---------------------------------------------------------------------------
// Terminal finalizers — every failure path funnels through exactly one of
// these, which emit the terminal audit event, end the span, and build the
// envelope (SI-12: exactly one envelope per execution).
// ---------------------------------------------------------------------------

type FailContext = {
  attempts?: number;
  executedBeforeFailure?: boolean;
  policyDecisions?: PolicyDecisionRecord[];
};

function finalizeDenied(
  frame: ExecutionFrameLike,
  reason: DeniedReason,
  error: CapabilityError,
  policyDecisions?: PolicyDecisionRecord[],
): ExecutionResult<never> {
  const data: Extract<AgentAuditEvent, { type: "capability.denied" }>["data"] = {
    reason,
    publicCode: error.code,
  };
  if (policyDecisions && policyDecisions.length > 0) data.policyDecisions = policyDecisions;
  frame.deps.audit.emit({ type: "capability.denied", ...envelope(frame), data });
  frame.span.recordError(error);
  frame.span.setAttributes({ "orpc_agent.outcome": "failed", "orpc_agent.error_code": error.code });
  frame.span.end("error");
  return { status: "failed", executionId: frame.executionId!, error };
}

function finalizeFailed(
  frame: ExecutionFrameLike,
  error: CapabilityError,
  context: FailContext = {},
): ExecutionResult<never> {
  const data: Extract<AgentAuditEvent, { type: "capability.failed" }>["data"] = {
    code: error.code,
    stage: error.stage,
    retryable: error.retryable,
    attempts: context.attempts ?? 0,
  };
  if (context.executedBeforeFailure) data.executedBeforeFailure = true;
  if (context.policyDecisions && context.policyDecisions.length > 0) {
    data.policyDecisions = context.policyDecisions;
  }
  frame.deps.audit.emit({ type: "capability.failed", ...envelope(frame), data });
  frame.span.recordError(error);
  frame.span.setAttributes({ "orpc_agent.outcome": "failed", "orpc_agent.error_code": error.code });
  frame.span.end("error");
  return { status: "failed", executionId: frame.executionId!, error };
}

function finalizeCancelled(
  frame: ExecutionFrameLike & { startedAt: Date },
  error: CapabilityError,
): ExecutionResult<never> {
  frame.deps.audit.emit({
    type: "capability.cancelled",
    ...envelope(frame),
    data: { code: error.code as "TIMEOUT" | "CANCELLED", durationMs: durationMs(frame) },
  });
  frame.span.recordError(error);
  frame.span.setAttributes({ "orpc_agent.outcome": "cancelled", "orpc_agent.error_code": error.code });
  frame.span.end("error");
  return { status: "cancelled", executionId: frame.executionId!, error };
}

type ExecutionFrameLike = {
  deps: PipelineDeps;
  surface: ExposureSurface;
  actor: Actor;
  executionId?: string;
  capabilityId?: string;
  correlationId?: string;
  inputHash?: string;
  span: SpanHandle;
};

// ---------------------------------------------------------------------------
// Invocation pipeline (stages 2–15)
// ---------------------------------------------------------------------------

export async function invokePipeline<O>(
  deps: PipelineDeps,
  args: InvokeArgs,
): Promise<ExecutionResult<O>> {
  // Stage 2 — execution identity. Emitted before resolution so even requests
  // for unknown capabilities are auditable.
  const executionId = newId("exe");
  const startedAt = deps.now();
  const peeked = deps.registry.get(args.capabilityId);
  const span = deps.tracing.startSpan("agent.capability_call", {
    "orpc_agent.capability_id": args.capabilityId,
    "orpc_agent.surface": args.surface,
    "orpc_agent.actor_kind": args.actor?.kind ?? "unknown",
    ...(typeof args.actor?.id === "string" ? { "orpc_agent.actor_id": args.actor.id } : {}),
    "orpc_agent.execution_id": executionId,
  });

  const frameBase = {
    deps,
    surface: args.surface,
    actor: args.actor ?? { id: "unknown", kind: "anonymous" as const },
    executionId,
    capabilityId: args.capabilityId,
    correlationId: args.correlationId,
    span,
  };

  try {
    {
      const data: { sideEffect?: AgentCapability["meta"]["sideEffect"]; risk?: AgentCapability["meta"]["risk"] } =
        {};
      if (peeked) {
        data.sideEffect = peeked.meta.sideEffect;
        data.risk = peeked.meta.risk;
      }
      deps.audit.emit({ type: "capability.requested", ...envelope(frameBase), data });
    }

    // Stage 3 — capability resolution.
    const capability = peeked;
    if (!capability) {
      return finalizeDenied(frameBase, "unknown", new CapabilityError({ code: "CAPABILITY_NOT_FOUND" }));
    }
    span.setAttributes({
      "orpc_agent.side_effect": capability.meta.sideEffect,
      "orpc_agent.risk": capability.meta.risk,
    });

    // Stage 4 — exposure check. Externally indistinguishable from a missing
    // capability (SI-8); the audit event records the true reason.
    if (capability.meta.expose[args.surface] !== true) {
      return finalizeDenied(
        frameBase,
        "not-exposed",
        new CapabilityError({ code: "CAPABILITY_NOT_FOUND" }),
      );
    }

    // Stage 5 — input validation (Standard Schema). The validated value — not
    // the raw one — is what every later stage sees (SI-6).
    let validatedInput: unknown = args.rawInput;
    if (capability.inputSchema) {
      const result = await capability.inputSchema["~standard"].validate(args.rawInput);
      if (result.issues) {
        return finalizeFailed(
          frameBase,
          new CapabilityError({
            code: "INPUT_INVALID",
            details: { issues: summarizeIssues(result.issues) },
          }),
        );
      }
      validatedInput = result.value;
    }

    const inputHash = await tryHash(validatedInput);
    const frameWithHash = { ...frameBase, inputHash };

    // Stage 6 — actor check. Anonymous access is modeled explicitly, never by
    // omitting the actor.
    if (!isWellFormedActor(args.actor)) {
      return finalizeFailed(frameWithHash, new CapabilityError({ code: "UNAUTHENTICATED" }));
    }

    // Stage 7 — invocation-phase policies (runtime-level, then capability).
    const policies = collectPolicies(deps.policies, capability.meta.policies);
    const policyRequest: PolicyRequest = {
      phase: "invocation",
      capability: { id: capability.id, meta: capability.meta },
      surface: args.surface,
      actor: args.actor,
      context: args.context,
      input: validatedInput,
    };
    const stage7 = await runPolicyBatch(deps, span, policies, "invocation", policyRequest);
    const denied = policyOutcomeToDenial(frameWithHash, stage7);
    if (denied) return denied;

    const frame: ExecutionFrame = {
      deps,
      executionId,
      capability,
      actor: args.actor,
      context: args.context,
      surface: args.surface,
      validatedInput,
      inputForCall: args.rawInput,
      inputHash,
      callerSignal: args.signal,
      correlationId: args.correlationId,
      span,
      startedAt,
      policyRecords: stage7.records,
    };

    // Stage 8 — approval gate (static meta gate merged with policy decisions).
    const staticRequired = capability.meta.approval?.required === true;
    if (staticRequired || stage7.requireApprovals.length > 0) {
      const gate = await approvalGate<O>(frame, stage7.requireApprovals);
      if (gate.result) return gate.result;
      frame.approval = gate.approval;
    }

    return executeGoverned<O>(frame);
  } catch (unexpected) {
    // The envelope-never-throws property: runtime invariant violations still
    // produce a failed envelope.
    return finalizeFailed(
      frameBase,
      new CapabilityError({ code: "INTERNAL_ERROR", cause: unexpected }),
    );
  }
}

// ---------------------------------------------------------------------------
// Resume (re-enters at stage 8's integrity checks, then stages 9–15)
// ---------------------------------------------------------------------------

export async function resumePipeline<O>(
  deps: PipelineDeps,
  args: ResumeArgs,
): Promise<ExecutionResult<O>> {
  const executionId = newId("exe");
  const startedAt = deps.now();

  const record = await deps.coordinator.get(args.approvalId);
  if (!record) {
    const span = deps.tracing.startSpan("agent.capability_call", {
      "orpc_agent.execution_id": executionId,
    });
    const frame = {
      deps,
      surface: "direct" as ExposureSurface,
      actor: { id: "unknown", kind: "anonymous" as const },
      executionId,
      span,
    };
    return finalizeFailed(
      frame,
      new CapabilityError({
        code: "INTERNAL_ERROR",
        stage: "approval",
        cause: new Error(`approval record "${args.approvalId}" was not found`),
      }),
    );
  }

  const span = deps.tracing.startSpan("agent.capability_call", {
    "orpc_agent.capability_id": record.capabilityId,
    "orpc_agent.surface": record.surface,
    "orpc_agent.actor_kind": record.actor.kind,
    "orpc_agent.actor_id": record.actor.id,
    "orpc_agent.execution_id": executionId,
    "orpc_agent.approval_id": record.id,
  });
  const frameBase: ExecutionFrameLike = {
    deps,
    surface: record.surface,
    actor: record.actor,
    executionId,
    capabilityId: record.capabilityId,
    inputHash: record.inputHash,
    span,
  };
  const fail = (code: ErrorCode) =>
    finalizeFailed(frameBase, new CapabilityError({ code, stage: "approval" }));

  try {
    // Integrity checks (SI-4, SI-5).
    if (record.status === "pending") return fail("APPROVAL_PENDING");
    if (record.status === "rejected") return fail("APPROVAL_REJECTED");
    if (record.status === "consumed") return fail("APPROVAL_CONSUMED");
    if (
      record.status === "expired" ||
      deps.now().getTime() > record.expiresAt.getTime()
    ) {
      return fail("APPROVAL_EXPIRED");
    }
    if (record.status !== "approved" || !record.decision) {
      // "cancelled" (application withdrew) or a malformed record.
      return finalizeFailed(
        frameBase,
        new CapabilityError({
          code: "INTERNAL_ERROR",
          stage: "approval",
          cause: new Error(`approval "${record.id}" is not resumable (status: ${record.status})`),
        }),
      );
    }
    const approver = record.decision.approver;
    if (deps.rejectSelfApproval && approver.id === record.actor.id) {
      return fail("APPROVAL_SELF_APPROVAL");
    }

    // Re-hash the stored input and compare (tamper check on the store).
    let storedHash: string | undefined;
    try {
      storedHash = await hashInput(record.input);
    } catch {
      storedHash = undefined;
    }
    if (storedHash !== record.inputHash) return fail("APPROVAL_INPUT_MISMATCH");

    // Resolve against the CURRENT registry and re-validate against the
    // CURRENT schema (the deploy may have changed since approval).
    const capability = deps.registry.get(record.capabilityId);
    if (!capability) {
      return finalizeDenied(
        frameBase,
        "unknown",
        new CapabilityError({ code: "CAPABILITY_NOT_FOUND" }),
      );
    }
    let validatedInput: unknown = record.input;
    if (capability.inputSchema) {
      const result = await capability.inputSchema["~standard"].validate(record.input);
      if (result.issues) {
        return finalizeFailed(
          frameBase,
          new CapabilityError({
            code: "INPUT_INVALID",
            details: { issues: summarizeIssues(result.issues) },
          }),
        );
      }
      validatedInput = result.value;
    }

    // Atomic single-use consumption — an approval executes at most once.
    try {
      await deps.coordinator.markConsumed(record.id, executionId);
    } catch (cause) {
      return finalizeFailed(
        frameBase,
        new CapabilityError({ code: "APPROVAL_CONSUMED", stage: "approval", cause }),
      );
    }

    // Continue at stage 9 as the ORIGINAL actor, approver in ctx.agent.
    const frame: ExecutionFrame = {
      deps,
      executionId,
      capability,
      actor: record.actor,
      context: args.context,
      surface: record.surface,
      validatedInput,
      inputForCall: record.input,
      inputHash: record.inputHash,
      callerSignal: args.signal,
      correlationId: undefined,
      approval: { id: record.id, approver, record },
      span,
      startedAt,
      policyRecords: [],
    };
    return executeGoverned<O>(frame);
  } catch (unexpected) {
    return finalizeFailed(
      frameBase,
      new CapabilityError({ code: "INTERNAL_ERROR", cause: unexpected }),
    );
  }
}

// ---------------------------------------------------------------------------
// Stage 8 helpers
// ---------------------------------------------------------------------------

async function approvalGate<O>(
  frame: ExecutionFrame,
  requireApprovals: { policy: string; decision: RequireApprovalDecision }[],
): Promise<{ result?: ExecutionResult<O>; approval?: ExecutionFrame["approval"] }> {
  const { deps, capability } = frame;

  // Canonical serialization gate: approvals must bind a verifiable value.
  if (frame.inputHash === undefined) {
    let cause: unknown;
    try {
      canonicalJson(frame.validatedInput);
    } catch (error) {
      cause = error;
    }
    return {
      result: finalizeFailed(
        frame,
        new CapabilityError({ code: "APPROVAL_UNSERIALIZABLE_INPUT", cause }),
        { policyDecisions: frame.policyRecords },
      ),
    };
  }

  const reasons: string[] = [];
  const types: string[] = [];
  if (capability.meta.approval?.required === true) {
    reasons.push(`Approval is required for ${capability.id}.`);
    if (capability.meta.approval.type) types.push(capability.meta.approval.type);
  }
  const expiries: number[] = [];
  for (const { decision } of requireApprovals) {
    reasons.push(decision.reason);
    if (decision.approvalType && !types.includes(decision.approvalType)) {
      types.push(decision.approvalType);
    }
    if (decision.expiresInMs !== undefined) expiries.push(decision.expiresInMs);
  }
  // Minimum expiry wins; fall back to the capability's, then the runtime's.
  const expiresInMs =
    expiries.length > 0
      ? Math.min(...expiries)
      : (capability.meta.approval?.expiresInMs ?? deps.defaults.approvalExpiresInMs);

  const requestedAt = deps.now();
  const request: ApprovalRequest = {
    id: newId("apr"),
    capabilityId: capability.id,
    surface: frame.surface,
    actor: frame.actor,
    input: frame.validatedInput,
    inputHash: frame.inputHash,
    reasons,
    types,
    risk: capability.meta.risk,
    sideEffect: capability.meta.sideEffect,
    requestedAt,
    expiresAt: new Date(requestedAt.getTime() + expiresInMs),
  };

  const approvalSpan = deps.tracing.startSpan(
    "agent.approval_request",
    {
      "orpc_agent.capability_id": capability.id,
      "orpc_agent.approval_id": request.id,
      "orpc_agent.execution_id": frame.executionId,
    },
    frame.span,
  );

  frame.deps.audit.emit({
    type: "capability.approval_requested",
    ...envelope(frame),
    data: {
      approvalId: request.id,
      reasons: request.reasons,
      types: request.types,
      expiresAt: request.expiresAt,
    },
  });

  // Inline handler mode: decide within the same call. Returning undefined
  // defers to the coordinator (suspend/resume) flow.
  if (deps.inlineHandler) {
    let decision: ApprovalDecision | undefined;
    try {
      decision = await deps.inlineHandler(request);
    } catch (cause) {
      approvalSpan.end("error");
      return {
        result: finalizeFailed(
          frame,
          new CapabilityError({ code: "INTERNAL_ERROR", stage: "approval", cause }),
          { policyDecisions: frame.policyRecords },
        ),
      };
    }
    if (decision !== undefined) {
      if (
        (decision.status !== "approved" && decision.status !== "rejected") ||
        !isWellFormedActor(decision.approver)
      ) {
        approvalSpan.end("error");
        return {
          result: finalizeFailed(
            frame,
            new CapabilityError({
              code: "INTERNAL_ERROR",
              stage: "approval",
              cause: new Error("inline approval handler returned an invalid decision"),
            }),
            { policyDecisions: frame.policyRecords },
          ),
        };
      }
      const approverRef = { id: decision.approver.id, kind: decision.approver.kind };
      const decidedEvent = {
        ...envelope(frame),
        data: {
          approvalId: request.id,
          approver: approverRef,
          ...(decision.comment !== undefined ? { comment: decision.comment } : {}),
        },
      };
      if (decision.status === "rejected") {
        deps.audit.emit({ type: "capability.rejected", ...decidedEvent });
        approvalSpan.end("ok");
        return {
          result: finalizeFailed(frame, new CapabilityError({ code: "APPROVAL_REJECTED" }), {
            policyDecisions: frame.policyRecords,
          }),
        };
      }
      deps.audit.emit({ type: "capability.approved", ...decidedEvent });
      if (deps.rejectSelfApproval && decision.approver.id === frame.actor.id) {
        approvalSpan.end("error");
        return {
          result: finalizeFailed(frame, new CapabilityError({ code: "APPROVAL_SELF_APPROVAL" }), {
            policyDecisions: frame.policyRecords,
          }),
        };
      }
      approvalSpan.end("ok");
      return { approval: { id: request.id, approver: decision.approver } };
    }
  }

  // Coordinator flow: suspend. The execution is suspended, not failed — the
  // span ends ok.
  let record: ApprovalRecord;
  try {
    record = await deps.coordinator.create(request);
  } catch (cause) {
    approvalSpan.end("error");
    return {
      result: finalizeFailed(
        frame,
        new CapabilityError({ code: "INTERNAL_ERROR", stage: "approval", cause }),
        { policyDecisions: frame.policyRecords },
      ),
    };
  }
  approvalSpan.end("ok");
  frame.span.setAttributes({
    "orpc_agent.outcome": "approval-required",
    "orpc_agent.approval_id": record.id,
  });
  frame.span.end("ok");
  return {
    result: { status: "approval-required", executionId: frame.executionId, approval: record },
  };
}

// ---------------------------------------------------------------------------
// Stages 9–15 (shared by invoke and resume)
// ---------------------------------------------------------------------------

async function executeGoverned<O>(frame: ExecutionFrame): Promise<ExecutionResult<O>> {
  const { deps, capability } = frame;

  // Stage 9 — execution-phase policies (opted-in only). At resumption these
  // are the freshness re-check; approval (when present) satisfies any
  // require-approval stance.
  const policies = collectPolicies(deps.policies, capability.meta.policies);
  const hasExecutionPhase = policies.some((p) => p.phases.includes("execution"));
  if (hasExecutionPhase) {
    const request: PolicyRequest = {
      phase: "execution",
      capability: { id: capability.id, meta: capability.meta },
      surface: frame.surface,
      actor: frame.actor,
      context: frame.context,
      input: frame.validatedInput,
      ...(frame.approval?.record ? { approval: frame.approval.record } : {}),
    };
    const stage9 = await runPolicyBatch(deps, frame.span, policies, "execution", request);
    frame.policyRecords = [...frame.policyRecords, ...stage9.records];

    if (stage9.failure) {
      return finalizeFailed(
        frame,
        new CapabilityError({ code: "POLICY_FAILED", cause: stage9.failure.error }),
        { policyDecisions: frame.policyRecords },
      );
    }
    if (stage9.deny) {
      return finalizeFailed(
        frame,
        new CapabilityError({
          code: "POLICY_DENIED",
          publicMessage: stage9.deny.message,
          details: { policy: stage9.deny.policy, code: stage9.deny.code },
        }),
        { policyDecisions: frame.policyRecords },
      );
    }
    if (stage9.hide) {
      return finalizeFailed(frame, new CapabilityError({ code: "CAPABILITY_NOT_FOUND" }), {
        policyDecisions: frame.policyRecords,
      });
    }
    if (stage9.requireApprovals.length > 0 && !frame.approval) {
      const gate = await approvalGate<O>(frame, stage9.requireApprovals);
      if (gate.result) return gate.result;
      frame.approval = gate.approval;
    }
  }

  // Stage 10 — controls + capability.started. In strict audit mode the write
  // is awaited; failure aborts BEFORE any execution (AUDIT_UNAVAILABLE).
  const startedEvent: AgentAuditEvent = {
    type: "capability.started",
    ...envelope(frame),
    data: { attempt: 1, ...(frame.approval ? { approvalId: frame.approval.id } : {}) },
  };
  if (deps.audit.strict) {
    try {
      await deps.audit.emitAwaited(startedEvent);
    } catch (cause) {
      return finalizeFailed(frame, new CapabilityError({ code: "AUDIT_UNAVAILABLE", cause }), {
        policyDecisions: frame.policyRecords,
      });
    }
  } else {
    deps.audit.emit(startedEvent);
  }

  // Stage 11 — procedure invocation through oRPC's call path (the app's
  // middleware chain runs here, unchanged — ADR-008). The retry loop wraps
  // this stage only (SI-11).
  const timeoutMs = capability.meta.timeoutMs ?? deps.defaults.timeoutMs;
  const maxAdditionalAttempts = capability.meta.retry?.maxAttempts ?? 0;
  const backoffBase = capability.meta.retry?.backoffMs ?? 250;
  let attempts = 0;

  const agentInfo = {
    executionId: frame.executionId,
    capabilityId: capability.id,
    surface: frame.surface,
    actor: frame.actor,
    ...(frame.approval ? { approval: { id: frame.approval.id, approver: frame.approval.approver } } : {}),
    ...(frame.correlationId !== undefined ? { correlationId: frame.correlationId } : {}),
    idempotencyKey: newId("idk"),
  };

  let output: unknown;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempts += 1;
    const composite = createCompositeSignal(frame.callerSignal, timeoutMs);
    const attemptSpan = deps.tracing.startSpan(
      "agent.procedure_execution",
      {
        "orpc_agent.capability_id": capability.id,
        "orpc_agent.execution_id": frame.executionId,
        "orpc_agent.attempt": attempts,
      },
      frame.span,
    );

    const callPromise = call(capability.procedure as AnyProcedure, frame.inputForCall, {
      context: { ...(frame.context as Record<string, unknown>), agent: agentInfo },
      signal: composite.signal,
      path: frame.capability.path,
    });

    const raced = await Promise.race([
      callPromise.then(
        (value) => ({ kind: "ok" as const, value }),
        (error) => ({ kind: "error" as const, error }),
      ),
      composite.aborted.then(() => ({ kind: "aborted" as const })),
    ]);

    if (raced.kind === "ok" && !composite.signal.aborted) {
      composite.dispose();
      attemptSpan.end("ok");
      output = raced.value;
      break;
    }

    // After abort the runtime does not consume a late result; the composite
    // classification wins over whatever the handler threw.
    if (composite.signal.aborted) {
      // Suppress unhandled rejection from the abandoned call.
      void callPromise.catch(() => {});
      const abortError = composite.signal.reason instanceof CapabilityError
        ? composite.signal.reason
        : new CapabilityError({
            code: composite.cancelledByCaller() ? "CANCELLED" : "TIMEOUT",
            cause: composite.signal.reason,
          });
      composite.dispose();
      attemptSpan.recordError(abortError);
      attemptSpan.end("error");

      if (abortError.code === "CANCELLED") {
        return finalizeCancelled(frame, abortError);
      }
      // TIMEOUT is retryable, but still subject to side-effect eligibility.
      if (!isRetryEligible(capability, abortError, attempts, maxAdditionalAttempts)) {
        return finalizeCancelled(frame, abortError);
      }
      const nextAttemptError = abortError;
      const stop = await scheduleRetry(frame, attempts, nextAttemptError, backoffBase);
      if (stop) return stop;
      continue;
    }

    composite.dispose();
    const error = normalizeExecutionError((raced as { kind: "error"; error: unknown }).error);
    attemptSpan.recordError(error);
    attemptSpan.end("error");

    if (error.code === "OUTPUT_INVALID") {
      // Stage 12 outcome — the handler ran; the output is withheld.
      return finalizeFailed(frame, error, {
        attempts,
        executedBeforeFailure: true,
        policyDecisions: frame.policyRecords,
      });
    }

    if (!isRetryEligible(capability, error, attempts, maxAdditionalAttempts)) {
      return finalizeFailed(frame, error, {
        attempts,
        policyDecisions: frame.policyRecords,
      });
    }
    const stop = await scheduleRetry(frame, attempts, error, backoffBase);
    if (stop) return stop;
  }

  // Stage 12 — output validation happened inside the oRPC call path
  // (delegated; failures surfaced as OUTPUT_INVALID above — see ADR-001
  // addendum for the Q2 resolution).

  // Stage 13 — output redaction. Redaction failures fail the execution: the
  // procedure already ran.
  let redacted: unknown = output;
  const redact = capability.meta.redact?.output;
  if (redact) {
    try {
      redacted = redact(output);
    } catch (cause) {
      return finalizeFailed(
        frame,
        new CapabilityError({
          code: "EXECUTION_FAILED",
          exposeToModel: false,
          cause,
        }),
        { attempts, executedBeforeFailure: true, policyDecisions: frame.policyRecords },
      );
    }
  }

  // Stages 14–15 — completion.
  frame.deps.audit.emit({
    type: "capability.completed",
    ...envelope(frame),
    data: { durationMs: durationMs(frame), attempts },
  });
  frame.span.setAttributes({
    "orpc_agent.outcome": "completed",
    "orpc_agent.attempt": attempts,
  });
  frame.span.end("ok");
  return { status: "completed", executionId: frame.executionId, output: redacted as O };
}

/** Emits capability.retried and waits out the backoff; returns a terminal envelope if cancelled while waiting. */
async function scheduleRetry(
  frame: ExecutionFrame,
  attemptsSoFar: number,
  previousError: CapabilityError,
  backoffBase: number,
): Promise<ExecutionResult<never> | undefined> {
  frame.deps.audit.emit({
    type: "capability.retried",
    ...envelope(frame),
    data: { attempt: attemptsSoFar + 1, previousErrorCode: previousError.code },
  });
  const cancelled = await delay(backoffBase * 2 ** (attemptsSoFar - 1), frame.callerSignal);
  if (cancelled) {
    return finalizeCancelled(
      frame,
      new CapabilityError({ code: "CANCELLED", cause: frame.callerSignal?.reason }),
    );
  }
  return undefined;
}

/** SI-11 eligibility: retryable error, attempts left, side effect allows it. */
function isRetryEligible(
  capability: AgentCapability,
  error: CapabilityError,
  attemptsSoFar: number,
  maxAdditionalAttempts: number,
): boolean {
  if (maxAdditionalAttempts <= 0) return false;
  if (attemptsSoFar > maxAdditionalAttempts) return false;
  if (!error.retryable) return false;
  const sideEffect = capability.meta.sideEffect;
  const writeLike = sideEffect !== "none" && sideEffect !== "read";
  if (writeLike && capability.meta.idempotent !== true) return false;
  const retryOn = capability.meta.retry?.retryOn;
  if (retryOn && !safePredicate(retryOn, error)) return false;
  return true;
}

function safePredicate(
  predicate: (error: CapabilityError) => boolean,
  error: CapabilityError,
): boolean {
  try {
    return predicate(error) !== false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Shared policy plumbing
// ---------------------------------------------------------------------------

async function runPolicyBatch(
  deps: PipelineDeps,
  parentSpan: SpanHandle,
  policies: AgentPolicy[],
  phase: "invocation" | "execution",
  request: PolicyRequest,
): Promise<PolicyEvaluationOutcome> {
  const applicable = policies.some((p) => p.phases.includes(phase));
  if (!applicable) return { records: [], requireApprovals: [] };
  const span = deps.tracing.startSpan(
    "agent.policy_evaluation",
    {
      "orpc_agent.capability_id": request.capability.id,
      "orpc_agent.surface": request.surface,
    },
    parentSpan,
  );
  try {
    const outcome = await evaluatePolicies(policies, phase, request, deps.defaults.policyTimeoutMs);
    span.end(outcome.failure ? "error" : "ok");
    return outcome;
  } catch (error) {
    span.end("error");
    throw error;
  }
}

/** Applies stage-7 precedence and produces the matching denial envelope. */
function policyOutcomeToDenial(
  frame: ExecutionFrameLike,
  outcome: PolicyEvaluationOutcome,
): ExecutionResult<never> | undefined {
  if (outcome.failure) {
    return finalizeDenied(
      frame,
      "policy-failed",
      new CapabilityError({ code: "POLICY_FAILED", cause: outcome.failure.error }),
      outcome.records,
    );
  }
  if (outcome.deny) {
    return finalizeDenied(
      frame,
      "policy-denied",
      new CapabilityError({
        code: "POLICY_DENIED",
        publicMessage: outcome.deny.message,
        details: { policy: outcome.deny.policy, code: outcome.deny.code },
      }),
      outcome.records,
    );
  }
  if (outcome.hide) {
    // A hide with no deny conceals: external CAPABILITY_NOT_FOUND (SI-8).
    return finalizeDenied(
      frame,
      "hidden",
      new CapabilityError({ code: "CAPABILITY_NOT_FOUND" }),
      outcome.records,
    );
  }
  return undefined;
}

async function tryHash(value: unknown): Promise<string | undefined> {
  try {
    return await hashInput(value);
  } catch {
    return undefined;
  }
}
