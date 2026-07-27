import { Procedure, type AnyProcedure } from "@orpc/server";
import type { AgentCapability, CapabilityRegistry } from "@orpc-agent/core";

export type HandlerOverride = (options: {
  input: never;
  context: never;
  signal?: AbortSignal;
  [key: string]: unknown;
}) => unknown;

/**
 * Derives a registry where the listed capabilities' procedure handlers are
 * replaced. Metadata, schemas, and the middleware chain are preserved — only
 * the handler body is stubbed, so governance tests need no database.
 */
export function overrideRegistry(
  registry: CapabilityRegistry,
  overrides: Record<string, HandlerOverride>,
): CapabilityRegistry {
  const unknown = Object.keys(overrides).filter((id) => registry.get(id) === undefined);
  if (unknown.length > 0) {
    throw new Error(
      `overrides reference unknown capabilities: ${unknown.map((u) => `"${u}"`).join(", ")}`,
    );
  }
  if (Object.keys(overrides).length === 0) return registry;

  const map = (capability: AgentCapability): AgentCapability => {
    const override = overrides[capability.id];
    if (!override) return capability;
    const def = (capability.procedure as AnyProcedure)["~orpc"];
    const procedure = new Procedure({
      ...def,
      handler: override as never,
    }) as AnyProcedure;
    return { ...capability, procedure };
  };

  return wrap(registry, map);
}

/** Derives a registry with per-capability meta.timeoutMs forced to `timeoutMs`. */
export function timeoutRegistry(
  registry: CapabilityRegistry,
  timeoutMs: number,
): CapabilityRegistry {
  return wrap(registry, (capability) => ({
    ...capability,
    meta: { ...capability.meta, timeoutMs },
  }));
}

function wrap(
  registry: CapabilityRegistry,
  map: (capability: AgentCapability) => AgentCapability,
): CapabilityRegistry {
  const mapped = new Map(registry.capabilities().map((c) => [c.id, map(c)]));
  const view: CapabilityRegistry = {
    ids: () => [...mapped.keys()],
    get: (id) => mapped.get(id),
    capabilities: () => [...mapped.values()],
    filter(query) {
      const predicate =
        typeof query === "function"
          ? query
          : (c: AgentCapability) =>
              registry
                .filter(query)
                .ids()
                .includes(c.id);
      const kept = new Set(
        [...mapped.values()].filter((c) => predicate(c)).map((c) => c.id),
      );
      return wrap(
        {
          ...view,
          capabilities: () => [...mapped.values()].filter((c) => kept.has(c.id)),
          ids: () => [...kept],
          get: (id) => (kept.has(id) ? mapped.get(id) : undefined),
          inspect: () => ({
            capabilities: [...mapped.values()].filter((c) => kept.has(c.id)),
            excluded: registry.inspect().excluded,
            unexposed: registry.inspect().unexposed.filter((id) => kept.has(id)),
          }),
          filter: view.filter,
        },
        (c) => c,
      );
    },
    inspect() {
      const base = registry.inspect();
      return {
        capabilities: [...mapped.values()],
        excluded: base.excluded,
        unexposed: base.unexposed,
      };
    },
  };
  return view;
}
