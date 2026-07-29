import { describe, expect, it } from "vitest";
import {
  allow,
  composePolicies,
  createAgentRuntime,
  defineGovernance,
  definePolicy,
} from "../src/index";
import { createCapabilityRegistry } from "../src/registry";
import { searchOrders } from "./fixtures";

const a = definePolicy("a", () => allow());
const b = definePolicy("b", () => allow(), { phases: ["discovery", "invocation"] });

function registry() {
  return createCapabilityRegistry({ orders: { search: searchOrders } });
}

describe("defineGovernance", () => {
  it("publishes the policy identity, in declaration order, without the closures", () => {
    const governance = defineGovernance({ registry: registry(), policies: [a, b] });

    expect(governance.manifest).toEqual([
      { name: "a", phases: ["invocation"] },
      { name: "b", phases: ["discovery", "invocation"] },
    ]);
    expect(governance.manifest.some((entry) => "evaluate" in entry)).toBe(false);
  });

  it("flattens composites, so removing a member is visible in the manifest", () => {
    const full = defineGovernance({ registry: registry(), policies: [composePolicies(a, b)] });
    const reduced = defineGovernance({ registry: registry(), policies: [composePolicies(a)] });

    expect(full.manifest.map((p) => p.name)).toEqual(["a", "b"]);
    // The composite's own name is unchanged between these two; only flattening
    // makes the removal observable at all.
    expect(reduced.manifest.map((p) => p.name)).toEqual(["a"]);
  });

  it("is frozen — reading configuration is not a handle on it", () => {
    const governance = defineGovernance({ registry: registry(), policies: [a] });

    expect(() => (governance.policies as unknown as unknown[]).push(b)).toThrow();
    expect(() => (governance.manifest as unknown as unknown[]).push({ name: "x" })).toThrow();
  });

  it("records an empty policy list as a fact, distinct from never declaring one", () => {
    expect(defineGovernance({ registry: registry() }).manifest).toEqual([]);
  });

  it("rejects a config that is not a registry", () => {
    expect(() => defineGovernance({ registry: {} as never })).toThrow(TypeError);
    expect(() =>
      defineGovernance({ registry: registry(), policies: a as never }),
    ).toThrow(TypeError);
  });
});

describe("createAgentRuntime with a governance", () => {
  it("evaluates exactly the published list — there is no policies key to append to", () => {
    const governance = defineGovernance({ registry: registry(), policies: [a, b] });
    const runtime = createAgentRuntime({ governance });

    expect(runtime.governance.manifest).toEqual(governance.manifest);
    expect(runtime.governance).toBe(governance);
  });

  it("refuses anything that is not a governance — there is no second form", () => {
    // The registry/policies pair used to be accepted here. It was the arm
    // where a runtime could evaluate a list no exported value names, so the
    // guarantee only held by convention. Removing it is what makes it hold.
    expect(() => createAgentRuntime({ registry: registry() } as never)).toThrow(/governance/);
    expect(() =>
      createAgentRuntime({ governance: { registry: registry() } } as never),
    ).toThrow(/governance/);
  });

  it("exposes the registry as a shorthand for the governance's own", () => {
    const governance = defineGovernance({ registry: registry() });

    expect(createAgentRuntime({ governance }).registry).toBe(governance.registry);
  });

  it("shares one governance across every runtime an application builds", () => {
    const governance = defineGovernance({ registry: registry(), policies: [a] });
    const dashboard = createAgentRuntime({ governance });
    const chat = createAgentRuntime({ governance });

    expect(chat.governance).toBe(dashboard.governance);
    expect(chat.governance.manifest).toEqual(dashboard.governance.manifest);
  });

  it("requires a governance", () => {
    expect(() => createAgentRuntime({} as never)).toThrow(/governance/);
  });
});
