import type { CapabilityRegistry } from "./registry";
import { flattenPolicy } from "./policy/define";
import { isPolicyCandidate } from "./policy/scope";
import type { AgentPolicy, PolicyManifestEntry } from "./policy/types";

/**
 * The governed surface of an application, declared once.
 *
 * `registry` and `policies` are the whole of what an agent may reach and what
 * is evaluated before it does. Everything else `createAgentRuntime` takes —
 * coordinator, audit sinks, clock, tracing — is per-instance wiring, not
 * governance: an application legitimately builds several runtimes over one
 * governance (a coordinator-backed one for its dashboard, an inline-confirm
 * one for chat), and they must not be able to disagree about what is governed.
 *
 * Declaring it separately is what makes that guarantee structural rather than
 * disciplinary. A runtime built from a governance cannot add to its policy
 * list — there is no `policies` key to append to — so the value an
 * application exports for tooling to read IS the list every one of its
 * runtimes evaluates. Reading it also needs no runtime instance, which
 * matters because runtimes are usually built inside a factory and
 * `@orpc-agent/cli` reads values, never calls functions.
 */
export type AgentGovernance = {
  readonly registry: CapabilityRegistry;
  /** As configured, in evaluation order. Consumed by `createAgentRuntime`. */
  readonly policies: readonly AgentPolicy[];
  /**
   * The statically knowable identity and applicability of those policies,
   * composites flattened to match evaluation and audit records. This is what
   * governance tooling reads; `evaluate` is deliberately not reachable from
   * it, since a decision is only meaningful inside the pipeline.
   */
  readonly manifest: readonly PolicyManifestEntry[];
};

/**
 * Declares an application's governed surface. Pure, synchronous, no I/O —
 * safe at module scope, which is where tooling can see it.
 */
export function defineGovernance(config: {
  registry: CapabilityRegistry;
  /** Runtime-level, evaluated in order before capability policies. */
  policies?: AgentPolicy[];
}): AgentGovernance {
  if (!config || typeof config !== "object") {
    throw new TypeError("defineGovernance: config is required");
  }
  if (!config.registry || typeof config.registry.get !== "function") {
    throw new TypeError("defineGovernance: a capability registry is required");
  }
  if (config.policies !== undefined && !Array.isArray(config.policies)) {
    throw new TypeError("defineGovernance: policies must be an array");
  }

  const policies = Object.freeze([...(config.policies ?? [])]);
  return Object.freeze({
    registry: config.registry,
    policies,
    manifest: policyManifest(config.registry, policies),
  });
}

/**
 * Composites are flattened so reported names match the ones the pipeline
 * evaluates and audit records (`collectPolicies` does the same). Frozen: a
 * read of configuration, not a handle on it.
 */
export function policyManifest(
  registry: CapabilityRegistry,
  policies: readonly AgentPolicy[],
): readonly PolicyManifestEntry[] {
  const capabilities = registry.capabilities();
  const capabilityIds = new Set(capabilities.map((capability) => capability.id));
  return Object.freeze(
    [...policies]
      .flatMap(flattenPolicy)
      .map((policy) => {
        const unknownId = policy.scope?.capabilities?.ids?.find((id) => !capabilityIds.has(id));
        if (unknownId) {
          throw new TypeError(
            `defineGovernance: policy "${policy.name}" scopes unknown capability "${unknownId}"`,
          );
        }
        const ids = capabilities
          .filter((capability) => isPolicyCandidate(policy.scope, capability))
          .map((capability) => capability.id)
          .sort();
        return Object.freeze({
          name: policy.name,
          phases: Object.freeze([...policy.phases]),
          ...(policy.scope !== undefined ? { scope: policy.scope } : {}),
          capabilities: Object.freeze(ids),
        });
      }),
  );
}
