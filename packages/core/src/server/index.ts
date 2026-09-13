import { os, ORPCError } from "@orpc/server";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { hashInput, canonicalJson } from "../canonical";
import type { Actor, ExposureSurface } from "../types";
import { isWellFormedActor } from "../types";
import type { AgentRuntime, ExecutionResult, DescribeScope } from "../runtime/types";
import type { ApprovalRecord } from "../approvals/types";
import type {
  CapabilityInvokeRequest, CapabilityResumeRequest, CapabilityOutcome,
  InvocationReceipt, PortableApproval,
} from "../client/index";
import type { InvocationJournal, InvocationRecord } from "./journal";
import { exportCapabilityContract } from "./contracts";
export { exportCapabilityContract } from "./contracts";
export { createInMemoryInvocationJournal } from "./journal";
export type { InvocationJournal, InvocationRecord } from "./journal";

export type CapabilityPrincipal<TContext> = {
  actor: Actor;
  context: TContext;
  /** Trusted application/tenant partition; never taken from request JSON. */
  namespace: string;
};
export type CapabilityGatewayOperation = "describe" | "invoke" | "getInvocation" | "getApproval" | "resumeApproval";
export type CapabilityGatewayOptions<TRequestContext, TContext> = {
  authenticate(context: TRequestContext): Promise<CapabilityPrincipal<TContext>>;
  /** Must throw on denial. Shared audience, MFA, role and resource authorization belongs here. */
  authorize(request: { principal: CapabilityPrincipal<TContext>; operation: CapabilityGatewayOperation; capabilityId?: string; input?: unknown }): Promise<void>;
  /** New request emitter; reuse immutable governance, coordinators and pools. */
  createRuntime(principal: CapabilityPrincipal<TContext>): AgentRuntime<TContext>;
  journal: InvocationJournal;
  surface: Exclude<ExposureSurface, "direct" | "test">;
  /** Change when policy/handler meaning changes, including without a schema change. */
  revision: string;
  auditDrainTimeoutMs?: number;
  /** Entire request ceiling including authentication and audit drain. Default 25 seconds. */
  requestTimeoutMs?: number;
};

/** Native oRPC router. Mount with the application's RPCHandler; decisions are intentionally absent. */
export function createCapabilityGateway<TRequestContext extends object, TContext>(options: CapabilityGatewayOptions<TRequestContext, TContext>) {
  if (!options.journal || !options.authorize || !options.authenticate) throw new TypeError("Gateway requires authentication, authorization and an invocation journal");
  if (!["aiSdk", "mcp", "workflow"].includes(options.surface)) throw new TypeError("Gateway requires an agent surface");
  if (!options.revision?.trim()) throw new TypeError("Gateway requires a deployment revision");
  for (const timeout of [options.requestTimeoutMs ?? 25_000, options.auditDrainTimeoutMs ?? 5_000]) {
    if (!Number.isFinite(timeout) || timeout <= 0) throw new TypeError("Gateway deadlines must be positive");
  }
  if ((options.auditDrainTimeoutMs ?? 5_000) >= (options.requestTimeoutMs ?? 25_000)) throw new TypeError("Audit drain must fit within request deadline");
  const base = os.$context<TRequestContext>();
  async function session(requestContext: TRequestContext, signal: AbortSignal) {
    const principal = await options.authenticate(requestContext);
    if (!isWellFormedActor(principal.actor) || principal.actor.kind === "anonymous" || !principal.namespace?.trim()) throw new ORPCError("UNAUTHORIZED");
    const runtime = options.createRuntime(principal);
    const scope = await hashInput([principal.namespace, principal.actor.kind, principal.actor.id, options.surface]);
    return { principal, runtime, scope, signal };
  }
  type Session = Awaited<ReturnType<typeof session>>;
  async function authorized(s: Session, operation: CapabilityGatewayOperation, capabilityId?: string, input?: unknown) {
    await options.authorize({ principal: s.principal, operation, capabilityId, input });
  }
  async function run<R>(context: TRequestContext, callerSignal: AbortSignal | undefined, task: (s: Session) => Promise<R>): Promise<R> {
    const timeoutMs = options.requestTimeoutMs ?? 25_000;
    const drainMs = options.auditDrainTimeoutMs ?? 5_000;
    const controller = new AbortController();
    const signal = callerSignal ? AbortSignal.any([controller.signal, callerSignal]) : controller.signal;
    let operationTimer: ReturnType<typeof setTimeout> | undefined;
    let requestTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      operationTimer = setTimeout(() => controller.abort(new Error("Capability request deadline")), Math.max(1, timeoutMs - drainMs));
      return await Promise.race([
        (async () => {
          const s = await session(context, signal);
          try {
            signal.throwIfAborted();
            return await task(s);
          } finally { await s.runtime.drainAudit({ timeoutMs: drainMs }); }
        })(),
        new Promise<never>((_, reject) => { requestTimer = setTimeout(() => reject(new ORPCError("TIMEOUT")), timeoutMs); }),
      ]);
    } finally {
      if (operationTimer !== undefined) clearTimeout(operationTimer);
      if (requestTimer !== undefined) clearTimeout(requestTimer);
    }
  }
  async function contract(s: Session, capabilityId: string) {
    const capability = s.runtime.registry.get(capabilityId);
    if (!capability || capability.meta.expose[options.surface] !== true) return undefined;
    // Filter before conversion: unrelated non-model schemas need no converter.
    const governance = { ...s.runtime.governance, registry: s.runtime.registry.filter((c) => c.id === capabilityId) };
    return (await exportCapabilityContract(governance, options.revision))[0];
  }
  const unknown = (invocationId: string): CapabilityOutcome => ({ status: "outcome-unknown", invocationId });
  const failure = (invocationId: string, code: string, message: string): CapabilityOutcome => ({ status: "failed", invocationId, executionId: "", error: { code, message, retryable: false } });
  const saved = (record: InvocationRecord): CapabilityOutcome => record.state === "settled" && record.outcome ? record.outcome : unknown(record.invocationId);

  return {
    describe: base.input(schema<{ scope?: DescribeScope }>(validateDescribe)).handler(({ context, input, signal }) => run(context, signal, async (s) => {
      await authorized(s, "describe");
      const descriptors = await s.runtime.describe(options.surface, { actor: s.principal.actor, context: s.principal.context, scope: input.scope });
      return Promise.all(descriptors.map(async (descriptor) => ({ ...(await contract(s, descriptor.id))!, requiresApproval: descriptor.requiresApproval })));
    })),
    invoke: base.input(schema<CapabilityInvokeRequest>(validateInvoke)).handler(({ context, input, signal }) => run(context, signal, async (s) => {
      await authorized(s, "invoke", input.capabilityId, input.input);
      const descriptor = await contract(s, input.capabilityId);
      if (!descriptor) return failure(input.invocationId, "CAPABILITY_NOT_FOUND", "Capability not found.");
      if (input.contractDigest && input.contractDigest !== descriptor.contractDigest) return failure(input.invocationId, "CONTRACT_MISMATCH", "Capability contract changed. Refresh discovery.");
      let inputHash: string;
      try { inputHash = await hashInput(input.input); }
      catch { return failure(input.invocationId, "INPUT_INVALID", "Remote capability inputs must use JSON values."); }
      const now = new Date().toISOString();
      const record: InvocationRecord = {
        scope: s.scope, invocationId: input.invocationId, capabilityId: input.capabilityId,
        inputHash, input: input.input, contractDigest: descriptor.contractDigest, correlationId: input.correlationId,
        idempotencyKey: `idk_${await hashInput([s.scope, input.invocationId, input.capabilityId, inputHash])}`,
        claimToken: crypto.randomUUID(), state: "pending", createdAt: now, updatedAt: now,
      };
      s.signal.throwIfAborted();
      const claim = await options.journal.claim(record);
      if (claim.record.inputHash !== inputHash || claim.record.capabilityId !== input.capabilityId) return failure(input.invocationId, "INVOCATION_CONFLICT", "Invocation ID was already used for different input or capability.");
      if (!claim.claimed) return saved(claim.record);
      const result = await s.runtime.invoke(input.capabilityId, input.input, {
        actor: s.principal.actor, context: s.principal.context, surface: options.surface,
        correlationId: input.correlationId, idempotencyKey: record.idempotencyKey, signal: s.signal,
      });
      const outcome = portableResult(result, input.invocationId);
      if (outcome.status !== "outcome-unknown") await options.journal.settle(s.scope, input.invocationId, record.claimToken, outcome);
      return outcome;
    })),
    getInvocation: base.input(schema<{ invocationId: string }>((v) => exact(v, ["invocationId"]) && validId(v, "invocationId"))).handler(({ context, input, signal }) => run(context, signal, async (s) => {
      const record = await options.journal.get(s.scope, input.invocationId);
      await authorized(s, "getInvocation", record?.capabilityId, record?.input);
      if (!record) return null;
      return receipt(record);
    })),
    getApproval: base.input(schema<{ approvalId: string }>((v) => exact(v, ["approvalId"]) && validId(v, "approvalId"))).handler(({ context, input, signal }) => run(context, signal, async (s) => {
      const record = await options.journal.findApproval(s.scope, input.approvalId);
      await authorized(s, "getApproval", record?.capabilityId, record?.input);
      if (!record) return null;
      const approval = await s.runtime.approvals.get(input.approvalId);
      if (!approval || approval.actor.id !== s.principal.actor.id || approval.actor.kind !== s.principal.actor.kind || approval.surface !== options.surface) return null;
      return portableApproval(approval);
    })),
    resumeApproval: base.input(schema<CapabilityResumeRequest>(validateResume)).handler(({ context, input, signal }) => run(context, signal, async (s) => {
      const record = await options.journal.get(s.scope, input.invocationId);
      const approval = record?.approvalId === input.approvalId ? await s.runtime.approvals.get(input.approvalId) : null;
      await authorized(s, "resumeApproval", record?.capabilityId, approval?.input);
      if (!record || !approval || approval.actor.id !== s.principal.actor.id || approval.actor.kind !== s.principal.actor.kind || approval.surface !== options.surface) return failure(input.invocationId, "INTERNAL_ERROR", "The operation failed.");
      if (record.state !== "settled" || record.outcome?.status !== "approval-required") return saved(record);
      const descriptor = await contract(s, record.capabilityId);
      if (!descriptor || descriptor.contractDigest !== record.contractDigest || (input.contractDigest && input.contractDigest !== record.contractDigest)) return failure(input.invocationId, "CONTRACT_MISMATCH", "Approval contract changed. A new approval is required.");
      if (approval.status === "pending") return { ...record.outcome, approval: portableApproval(approval) };
      s.signal.throwIfAborted();
      const claimToken = crypto.randomUUID();
      if (!await options.journal.claimResume(s.scope, input.invocationId, input.approvalId, claimToken)) {
        const current = await options.journal.get(s.scope, input.invocationId);
        return current ? saved(current) : unknown(input.invocationId);
      }
      const result = await s.runtime.resume(input.approvalId, {
        context: s.principal.context, expectedActor: s.principal.actor, expectedSurface: options.surface,
        correlationId: record.correlationId, idempotencyKey: record.idempotencyKey, signal: s.signal,
      });
      const outcome = portableResult(result, input.invocationId);
      if (outcome.status !== "outcome-unknown") await options.journal.settle(s.scope, input.invocationId, claimToken, outcome);
      return outcome;
    })),
  };
}

function receipt(record: InvocationRecord): InvocationReceipt {
  const { scope: _scope, input: _input, inputHash: _hash, idempotencyKey: _key, claimToken: _token, ...result } = record;
  return result;
}
function portableApproval(record: ApprovalRecord): PortableApproval {
  return { id: record.id, capabilityId: record.capabilityId, status: record.status,
    reasons: [...record.reasons], types: [...record.types], requestedAt: record.requestedAt.toISOString(), expiresAt: record.expiresAt.toISOString() };
}
function portableResult(result: ExecutionResult, invocationId: string): CapabilityOutcome {
  if (result.status === "completed") {
    // Explicit wire contract: Date -> ISO string, undefined object properties omitted.
    const output = wireOutput(result.output);
    canonicalJson(output);
    return { status: "completed", invocationId, executionId: result.executionId, output };
  }
  if (result.status === "approval-required") return { ...result, invocationId, approval: portableApproval(result.approval) };
  if (result.effectStatus === "unknown") return { status: "outcome-unknown", invocationId };
  const error = result.error;
  return { status: result.status, invocationId, executionId: result.executionId, error: error.exposeToModel
    ? { code: error.code, message: error.publicMessage, retryable: error.retryable, ...(error.code === "INPUT_INVALID" && error.details !== undefined ? { details: error.details } : {}) }
    : { code: "INTERNAL_ERROR", message: "The operation failed.", retryable: false } };
}
function schema<T>(valid: (input: unknown) => boolean): StandardSchemaV1<T, T> {
  return { "~standard": { version: 1, vendor: "orpc-agent", validate: (value) => valid(value) ? { value: value as T } : { issues: [{ message: "Invalid capability gateway request" }] } } };
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value: unknown, keys: string[]): boolean { return object(value) && Object.keys(value).every((key) => keys.includes(key)); }
function validId(value: unknown, key: string): boolean { return object(value) && typeof value[key] === "string" && value[key].length > 0 && value[key].length <= 256; }
function optionalIds(value: Record<string, unknown>): boolean { return ["correlationId", "contractDigest"].every((key) => value[key] === undefined || validId(value, key)); }
function validateInvoke(value: unknown): boolean { return exact(value, ["invocationId", "capabilityId", "input", "correlationId", "contractDigest"]) && validId(value, "invocationId") && validId(value, "capabilityId") && optionalIds(value as Record<string, unknown>); }
function validateResume(value: unknown): boolean { return exact(value, ["invocationId", "approvalId", "correlationId", "contractDigest"]) && validId(value, "invocationId") && validId(value, "approvalId") && optionalIds(value as Record<string, unknown>); }
function validateDescribe(value: unknown): boolean {
  if (!object(value) || !exact(value, ["scope"])) return false;
  if (value.scope === undefined) return true;
  if (!object(value.scope) || !exact(value.scope, ["tags", "ids"])) return false;
  const scope = value.scope;
  return ["tags", "ids"].every((key) => scope[key] === undefined || (Array.isArray(scope[key]) && scope[key].length <= 1_000 && scope[key].every((v) => typeof v === "string" && v.length <= 256)));
}

/** JSON plus Date, without toJSON coercion or silently erasing unsupported values. */
function wireOutput(value: unknown, seen = new Set<object>()): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object" || value === null || seen.has(value)) throw new TypeError("Unsupported remote capability output");
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError("Remote output must be JSON or Date");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => wireOutput(item, seen));
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (descriptor.get || descriptor.set) throw new TypeError("Remote output cannot contain accessors");
      if (descriptor.enumerable && descriptor.value !== undefined) result[key] = wireOutput(descriptor.value, seen);
    }
    return result;
  } finally { seen.delete(value); }
}
