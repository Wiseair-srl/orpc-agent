import type { Actor, ExposureSurface } from "../types";
import type { PolicyRequest } from "../policy/types";
import type { CapabilityDescriptor } from "./types";
import type { PipelineDeps } from "./pipeline";
import { collectPolicies, evaluatePolicies } from "./policies";
import { isWellFormedActor } from "../types";
import { toJsonSchema, type JsonSchemaObject } from "../schema/index";

/**
 * Discovery pipeline: exposure filter → discovery-phase policies →
 * minimal descriptors → capabilities.discovered. Descriptors are advisory
 * for the client; every later invoke re-checks everything (SI-2).
 */
export async function describePipeline(
  deps: PipelineDeps,
  surface: ExposureSurface,
  options: { actor: Actor; context: unknown },
): Promise<CapabilityDescriptor[]> {
  if (!options || !isWellFormedActor(options.actor)) {
    throw new TypeError("describe: a well-formed actor is required");
  }

  const descriptors: CapabilityDescriptor[] = [];

  for (const capability of deps.registry.capabilities()) {
    // Exposure filter (SI-1).
    if (capability.meta.expose[surface] !== true) continue;

    let requiresApproval = capability.meta.approval?.required === true;

    const policies = collectPolicies(deps.policies, capability.meta.policies);
    if (policies.some((p) => p.phases.includes("discovery"))) {
      const request: PolicyRequest = {
        phase: "discovery",
        capability: { id: capability.id, meta: capability.meta },
        surface,
        actor: options.actor,
        context: options.context,
        // input is undefined at discovery.
      };
      const outcome = await evaluatePolicies(
        policies,
        "discovery",
        request,
        deps.defaults.policyTimeoutMs,
      );
      // deny/hide exclude (indistinguishable from nonexistent); policy errors
      // exclude too (fail closed, SI-7).
      if (outcome.failure || outcome.deny || outcome.hide) continue;
      if (outcome.requireApprovals.length > 0) requiresApproval = true;
    }

    let inputSchema: JsonSchemaObject;
    if (capability.inputSchema) {
      inputSchema = toJsonSchema(capability.inputSchema);
    } else {
      inputSchema = { type: "object" };
    }

    descriptors.push({
      id: capability.id,
      description: capability.meta.description,
      inputSchema,
      sideEffect: capability.meta.sideEffect,
      risk: capability.meta.risk,
      tags: [...(capability.meta.tags ?? [])],
      ...(requiresApproval ? { requiresApproval: true } : {}),
    });
  }

  deps.audit.emit({
    type: "capabilities.discovered",
    timestamp: deps.now(),
    surface,
    actor: { id: options.actor.id, kind: options.actor.kind },
    data: { capabilityIds: descriptors.map((d) => d.id) },
  });

  return descriptors;
}
