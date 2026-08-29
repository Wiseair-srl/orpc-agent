import type { AgentCapability } from "../registry";
import {
  EXPOSURE_SURFACES,
  RISK_LEVELS,
  SIDE_EFFECTS,
  type ExposureSurface,
  type RiskLevel,
  type SideEffect,
} from "../types";
import type { AgentPolicy, PolicyRequest, PolicyScope } from "./types";

const SCOPE_KEYS = new Set(["capabilities", "surfaces"]);
const CAPABILITY_KEYS = new Set(["ids", "tags", "sideEffects", "risks"]);

/** Validates, canonicalizes and freezes a declarative policy scope. */
export function normalizePolicyScope(scope: PolicyScope | undefined): PolicyScope | undefined {
  if (scope === undefined) return undefined;
  if (!isRecord(scope)) {
    throw new TypeError("definePolicy: scope must be an object");
  }
  rejectUnknownKeys(scope, SCOPE_KEYS, "scope");

  const capabilities = scope.capabilities;
  if (capabilities !== undefined && !isRecord(capabilities)) {
    throw new TypeError("definePolicy: scope.capabilities must be an object");
  }
  if (capabilities) rejectUnknownKeys(capabilities, CAPABILITY_KEYS, "scope.capabilities");

  const ids = stringArray(capabilities?.ids, "scope.capabilities.ids");
  const tags = stringArray(capabilities?.tags, "scope.capabilities.tags");
  const sideEffects = enumArray(
    capabilities?.sideEffects,
    SIDE_EFFECTS,
    "scope.capabilities.sideEffects",
  );
  const risks = enumArray(capabilities?.risks, RISK_LEVELS, "scope.capabilities.risks");
  const surfaces = enumArray(scope.surfaces, EXPOSURE_SURFACES, "scope.surfaces");

  const normalizedCapabilities =
    capabilities === undefined
      ? undefined
      : Object.freeze({
          ...(ids !== undefined ? { ids } : {}),
          ...(tags !== undefined ? { tags } : {}),
          ...(sideEffects !== undefined ? { sideEffects } : {}),
          ...(risks !== undefined ? { risks } : {}),
        });

  return Object.freeze({
    ...(normalizedCapabilities !== undefined ? { capabilities: normalizedCapabilities } : {}),
    ...(surfaces !== undefined ? { surfaces } : {}),
  });
}

/** True when the policy evaluates for this phase and concrete request. */
export function policyApplies(policy: AgentPolicy, phase: PolicyRequest["phase"], request: PolicyRequest): boolean {
  return policy.phases.includes(phase) && policyScopeMatches(policy.scope, request);
}

/** Runtime match: static capability fields plus the request surface. */
export function policyScopeMatches(scope: PolicyScope | undefined, request: PolicyRequest): boolean {
  if (!capabilityMatchesPolicyScope(scope, request.capability)) return false;
  return scope?.surfaces === undefined || scope.surfaces.includes(request.surface);
}

/** Static capability match, independent of a concrete invocation surface. */
export function capabilityMatchesPolicyScope(
  scope: PolicyScope | undefined,
  capability: Pick<AgentCapability, "id" | "meta">,
): boolean {
  const selector = scope?.capabilities;
  if (!selector) return true;
  if (selector.ids !== undefined && !selector.ids.includes(capability.id)) return false;
  if (
    selector.tags !== undefined &&
    !selector.tags.some((tag) => (capability.meta.tags ?? []).includes(tag))
  ) {
    return false;
  }
  if (
    selector.sideEffects !== undefined &&
    !selector.sideEffects.includes(capability.meta.sideEffect)
  ) {
    return false;
  }
  if (selector.risks !== undefined && !selector.risks.includes(capability.meta.risk)) return false;
  return true;
}

/** A static candidate must also be reachable on one of the scoped surfaces. */
export function isPolicyCandidate(
  scope: PolicyScope | undefined,
  capability: Pick<AgentCapability, "id" | "meta">,
): boolean {
  if (!capabilityMatchesPolicyScope(scope, capability)) return false;
  if (scope?.surfaces === undefined) return true;
  return scope.surfaces.some((surface) => capability.meta.expose[surface] === true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: Set<string>, path: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new TypeError(`definePolicy: ${path}.${unknown} is not supported`);
}

function stringArray(value: unknown, path: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new TypeError(`definePolicy: ${path} must be an array of non-empty strings`);
  }
  return Object.freeze([...new Set(value as string[])].sort());
}

function enumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): readonly T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => !allowed.includes(entry as T))) {
    throw new TypeError(`definePolicy: ${path} contains an unsupported value`);
  }
  const selected = new Set(value as T[]);
  return Object.freeze(allowed.filter((entry) => selected.has(entry)));
}
