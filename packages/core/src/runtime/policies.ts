import type { AgentPolicy, PolicyDecision, PolicyPhase, PolicyRequest } from "../policy/types";
import { flattenPolicy } from "../policy/define";
import type { PolicyDecisionRecord } from "../events";

export type RequireApprovalDecision = Extract<PolicyDecision, { type: "require-approval" }>;

export type PolicyEvaluationOutcome = {
  /** Every evaluated policy's stance, in evaluation order. */
  records: PolicyDecisionRecord[];
  /** First policy that threw or timed out (fail closed, SI-7). */
  failure?: { policy: string; error: unknown };
  /** First deny, if any (deny > hide > require-approval > allow). */
  deny?: { policy: string; code?: string; message?: string };
  hide?: { policy: string };
  requireApprovals: { policy: string; decision: RequireApprovalDecision }[];
};

/** Runtime-level policies first, then capability policies; composites flattened. */
export function collectPolicies(
  runtimePolicies: AgentPolicy[],
  capabilityPolicies: AgentPolicy[] | undefined,
): AgentPolicy[] {
  return [...runtimePolicies, ...(capabilityPolicies ?? [])].flatMap(flattenPolicy);
}

/**
 * Evaluates ALL applicable policies (no short-circuiting — the audit record
 * captures every stance) against a shared batch deadline of `timeoutMs`.
 */
export async function evaluatePolicies(
  policies: AgentPolicy[],
  phase: PolicyPhase,
  request: PolicyRequest,
  timeoutMs: number,
): Promise<PolicyEvaluationOutcome> {
  const outcome: PolicyEvaluationOutcome = { records: [], requireApprovals: [] };
  const deadline = performance.now() + timeoutMs;

  for (const policy of policies) {
    if (!policy.phases.includes(phase)) continue;

    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      outcome.records.push({ policy: policy.name, type: "error" });
      outcome.failure ??= {
        policy: policy.name,
        error: new Error(`policy evaluation batch exceeded ${timeoutMs}ms`),
      };
      // The batch budget is exhausted; nothing further can evaluate in time.
      break;
    }

    try {
      const decision = await withTimeout(
        Promise.resolve(policy.evaluate(request)),
        remaining,
        policy.name,
      );
      if (!isPolicyDecision(decision)) {
        throw new TypeError(
          `policy "${policy.name}" returned an invalid decision (use allow/deny/hide/requireApproval)`,
        );
      }
      outcome.records.push({ policy: policy.name, type: decision.type });
      if (decision.type === "deny") {
        outcome.deny ??= { policy: policy.name, code: decision.code, message: decision.message };
      } else if (decision.type === "hide") {
        outcome.hide ??= { policy: policy.name };
      } else if (decision.type === "require-approval") {
        outcome.requireApprovals.push({ policy: policy.name, decision });
      }
    } catch (error) {
      outcome.records.push({ policy: policy.name, type: "error" });
      outcome.failure ??= { policy: policy.name, error };
    }
  }

  return outcome;
}

function isPolicyDecision(value: unknown): value is PolicyDecision {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === "allow" || type === "deny" || type === "hide" || type === "require-approval";
}

function withTimeout<T>(promise: Promise<T>, ms: number, policyName: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`policy "${policyName}" exceeded the evaluation timeout`)),
      ms,
    );
    (timer as { unref?: () => void }).unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
