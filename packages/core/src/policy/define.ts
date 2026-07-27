import type { AgentPolicy, PolicyDecision, PolicyPhase, PolicyRequest } from "./types";

/**
 * Wraps a decision function with a stable name (used in audit events) and
 * phase declaration. Semantics: docs/concepts/policies.md.
 */
export function definePolicy(
  name: string,
  evaluate: (req: PolicyRequest) => PolicyDecision | Promise<PolicyDecision>,
  options?: { phases?: PolicyPhase[] },
): AgentPolicy {
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("definePolicy: name must be a non-empty string");
  }
  if (typeof evaluate !== "function") {
    throw new TypeError("definePolicy: evaluate must be a function");
  }
  return {
    name,
    phases: options?.phases ?? ["invocation"],
    evaluate,
  };
}

const COMPOSED = Symbol.for("orpc-agent.composed-policies");

type ComposedPolicy = AgentPolicy & { [COMPOSED]: AgentPolicy[] };

/**
 * Combines policies into one, preserving order and per-policy audit identity
 * (the runtime flattens composites before evaluation). Standalone use applies
 * the standard precedence: deny > hide > require-approval > allow.
 */
export function composePolicies(...policies: AgentPolicy[]): AgentPolicy {
  const flattened = policies.flatMap(flattenPolicy);
  const phases = [...new Set(flattened.flatMap((p) => p.phases))];
  const composite: ComposedPolicy = {
    name: `composed(${flattened.map((p) => p.name).join(",")})`,
    phases,
    async evaluate(req) {
      const decisions: PolicyDecision[] = [];
      for (const policy of flattened) {
        if (!policy.phases.includes(req.phase)) continue;
        decisions.push(await policy.evaluate(req));
      }
      return combineByPrecedence(decisions);
    },
    [COMPOSED]: flattened,
  };
  return composite;
}

/** Runtime helper: expands composites so audit identity is per inner policy. */
export function flattenPolicy(policy: AgentPolicy): AgentPolicy[] {
  const inner = (policy as Partial<ComposedPolicy>)[COMPOSED];
  return inner ? inner.flatMap(flattenPolicy) : [policy];
}

function combineByPrecedence(decisions: PolicyDecision[]): PolicyDecision {
  return (
    decisions.find((d) => d.type === "deny") ??
    decisions.find((d) => d.type === "hide") ??
    decisions.find((d) => d.type === "require-approval") ??
    { type: "allow" }
  );
}
