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
    const runtime = createAgentRuntime({ governance, warnings: false });

    expect(runtime.policies).toEqual(governance.manifest);
    expect(runtime.governance).toBe(governance);
  });

  it("normalizes the inline registry/policies form into the same shape", () => {
    const runtime = createAgentRuntime({ registry: registry(), policies: [a], warnings: false });

    expect(runtime.governance.manifest).toEqual([{ name: "a", phases: ["invocation"] }]);
    expect(runtime.registry).toBe(runtime.governance.registry);
  });

  it("shares one governance across every runtime an application builds", () => {
    const governance = defineGovernance({ registry: registry(), policies: [a] });
    const dashboard = createAgentRuntime({ governance, warnings: false });
    const chat = createAgentRuntime({ governance, warnings: false });

    expect(chat.governance).toBe(dashboard.governance);
    expect(chat.policies).toEqual(dashboard.policies);
  });

  it("still requires a registry when no governance is given", () => {
    expect(() => createAgentRuntime({} as never)).toThrow(/governance|registry/);
  });
});
