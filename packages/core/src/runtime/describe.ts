import type { Actor, ExposureSurface } from "../types";
import type { AgentCapability } from "../registry";
import type { PolicyRequest } from "../policy/types";
import type { CapabilityDescriptor, DescribeOptions, DescribeScope } from "./types";
import type { PipelineDeps } from "./pipeline";
import { collectPolicies, evaluatePolicies } from "./policies";
import { isWellFormedActor } from "../types";
import { CapabilityError } from "../errors";
import { hashInput } from "../canonical";
import { toJsonSchema, type JsonSchemaObject } from "../schema/index";

/**
 * Discovery pipeline: exposure filter → scope filter → discovery-phase
 * policies → minimal descriptors → capabilities.discovered. Descriptors are
 * advisory for the client; every later invoke re-checks everything (SI-2).
 *
 * The scope filter sits at step 2, not after the policies, and that placement
 * is the point: at step 3 it would only save tokens, here it saves the policy
 * evaluations themselves (ADR-017).
 */
export async function describePipeline(
  deps: PipelineDeps,
  surface: ExposureSurface,
  options: DescribeOptions<unknown>,
): Promise<CapabilityDescriptor[]> {
  if (!options || !isWellFormedActor(options.actor)) {
    throw new TypeError("describe: a well-formed actor is required");
  }
  const scope = normalizeScope(options.scope);

  // Steps 1–2. Both are local and cheap, and no policy has run yet.
  const candidates = deps.registry
    .capabilities()
    .filter((capability) => capability.meta.expose[surface] === true && inScope(capability, scope));

  // Step 3, up to `policyConcurrency` capabilities at a time. Results land by
  // index so the returned order stays registry order regardless of who
  // finishes first.
  const evaluated: (CapabilityDescriptor | null)[] = new Array(candidates.length).fill(null);
  const deadline = performance.now() + deps.defaults.discoveryBudgetMs;
  let next = 0;
  let stopped = false;

  const worker = async (): Promise<void> => {
    while (!stopped) {
      const index = next++;
      if (index >= candidates.length) return;
      const capability = candidates[index]!;

      let requiresApproval = capability.meta.approval?.required === true;

      const policies = collectPolicies(deps.policies, capability.meta.policies);
      if (policies.some((p) => p.phases.includes("discovery"))) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          stopped = true;
          throw discoveryTimedOut(deps.defaults.discoveryBudgetMs);
        }

        const request: PolicyRequest = {
          phase: "discovery",
          capability: { id: capability.id, meta: capability.meta },
          surface,
          actor: options.actor,
          context: options.context,
          // input is undefined at discovery.
        };
        // Clamped to what is left of the global budget, so one slow batch
        // cannot spend the whole discovery's ceiling by itself.
        const outcome = await evaluatePolicies(
          policies,
          "discovery",
          request,
          Math.min(deps.defaults.policyTimeoutMs, remaining),
        );

        // Once the budget is gone, every exclusion below becomes unreadable:
        // "policy said no" and "we ran out of time" would look identical in a
        // short catalog. Fail instead.
        if (performance.now() >= deadline) {
          stopped = true;
          throw discoveryTimedOut(deps.defaults.discoveryBudgetMs);
        }

        // deny/hide exclude (indistinguishable from nonexistent); policy errors
        // exclude too (fail closed, SI-7), and never reach a neighbour: each
        // capability gets its own batch and its own outcome.
        if (outcome.failure || outcome.deny || outcome.hide) continue;
        if (outcome.requireApprovals.length > 0) requiresApproval = true;
      }

      // Conversion is memoized per schema object; each descriptor gets its own
      // clone so a caller mutating descriptor.inputSchema cannot poison the
      // cache for every later describe/tool build.
      let inputSchema: JsonSchemaObject;
      if (capability.inputSchema) {
        inputSchema = structuredClone(toJsonSchema(capability.inputSchema));
      } else {
        inputSchema = { type: "object" };
      }

      evaluated[index] = {
        id: capability.id,
        description: capability.meta.description,
        inputSchema,
        sideEffect: capability.meta.sideEffect,
        risk: capability.meta.risk,
        tags: [...(capability.meta.tags ?? [])],
        ...(requiresApproval ? { requiresApproval: true } : {}),
      };
    }
  };

  const lanes = Math.max(1, Math.min(deps.defaults.policyConcurrency, candidates.length));
  // allSettled, not all: a second lane hitting the same expired budget must
  // not become an unhandled rejection while the first one is propagating.
  const settled = await Promise.allSettled(Array.from({ length: lanes }, () => worker()));
  const rejected = settled.find((result) => result.status === "rejected");
  if (rejected) throw rejected.reason;

  const descriptors = evaluated.filter((d): d is CapabilityDescriptor => d !== null);

  const capabilityIds = descriptors.map((d) => d.id);
  deps.audit.emit({
    type: "capabilities.discovered",
    timestamp: deps.now(),
    surface,
    actor: { id: options.actor.id, kind: options.actor.kind },
    data: {
      count: descriptors.length,
      surface,
      digest: await catalogDigest(capabilityIds),
      ...(deps.audit.verbose ? { capabilityIds } : {}),
    },
  });

  return descriptors;
}

/** Sorted so that reordering the registry alone does not read as a change. */
async function catalogDigest(capabilityIds: string[]): Promise<string> {
  return hashInput([...capabilityIds].sort());
}

function discoveryTimedOut(budgetMs: number): CapabilityError {
  return new CapabilityError({
    code: "TIMEOUT",
    stage: "discovery",
    publicMessage: `Capability discovery exceeded its ${budgetMs}ms budget.`,
  });
}

type NormalizedScope = { tags?: Set<string>; ids?: Set<string> };

/**
 * `undefined` means "no narrowing" — that is also what an object carrying
 * neither key means, so `scope: {}` reads as omitting it rather than as
 * selecting nothing.
 */
function normalizeScope(scope: DescribeScope | undefined): NormalizedScope | undefined {
  if (scope === undefined) return undefined;
  if (typeof scope !== "object" || scope === null || Array.isArray(scope)) {
    throw new TypeError("describe: scope must be an object with optional tags and ids arrays");
  }
  const tags = readStringArray(scope.tags, "tags");
  const ids = readStringArray(scope.ids, "ids");
  if (!tags && !ids) return undefined;
  return { ...(tags ? { tags } : {}), ...(ids ? { ids } : {}) };
}

function readStringArray(value: unknown, key: string): Set<string> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new TypeError(`describe: scope.${key} must be an array of strings`);
  }
  return new Set(value as string[]);
}

/**
 * ANY across `tags`, exact across `ids`, union across both. An untagged
 * capability matches no `tags` scope — scope is opt-in, and a capability that
 * silently answered every group would defeat the point of asking for one.
 */
function inScope(capability: AgentCapability, scope: NormalizedScope | undefined): boolean {
  if (!scope) return true;
  if (scope.ids?.has(capability.id)) return true;
  if (scope.tags) {
    for (const tag of capability.meta.tags ?? []) {
      if (scope.tags.has(tag)) return true;
    }
  }
  return false;
}
