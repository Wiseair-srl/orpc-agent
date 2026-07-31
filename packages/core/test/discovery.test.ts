import { describe, expect, test } from "vitest";
import { os } from "@orpc/server";
import * as z from "zod";
import { createAgentRuntime } from "../src/runtime/create";
import { defineGovernance } from "../src/governance";
import { createCapabilityRegistry, type CapabilityDefs } from "../src/registry";
import { agentProcedure } from "../src/procedure";
import { definePolicy } from "../src/policy/define";
import { allow, hide } from "../src/policy/helpers";
import { isCapabilityError } from "../src/errors";
import { capturedEvents, dana } from "./helpers";
import type { AgentPolicy } from "../src/policy/types";

const base = agentProcedure(os.$context<object>());
const options = { actor: dana, context: {} };

function cap(tags?: string[], policies?: AgentPolicy[]) {
  return base
    .meta({
      agent: {
        description: "Target.",
        expose: { direct: true, aiSdk: true },
        sideEffect: "read",
        risk: "low",
        ...(tags ? { tags } : {}),
        ...(policies ? { policies } : {}),
      },
    })
    .input(z.object({}))
    .handler(async () => ({ ok: true }));
}

/** Six tag groups, the shape the 1.1 consumer discovers against. */
function taggedRuntime(policies: AgentPolicy[] = []) {
  const audit = capturedEvents();
  const registry = createCapabilityRegistry({
    devicesRead: cap(["devices"]),
    devicesWrite: cap(["devices", "writes"]),
    billingRead: cap(["billing"]),
    billingWrite: cap(["billing", "writes"]),
    reports: cap(["reports"]),
    untagged: cap(),
  });
  const runtime = createAgentRuntime({
    governance: defineGovernance({ registry, policies }),
    audit: audit.sink,
  });
  return { runtime, audit };
}

describe("N1 — scope narrows discovery before policies run", () => {
  test("tags select ANY listed tag; untagged capabilities match none", async () => {
    const { runtime } = taggedRuntime();
    const devices = await runtime.describe("direct", { ...options, scope: { tags: ["devices"] } });
    expect(devices.map((d) => d.id)).toEqual(["devicesRead", "devicesWrite"]);

    const twoGroups = await runtime.describe("direct", {
      ...options,
      scope: { tags: ["devices", "reports"] },
    });
    expect(twoGroups.map((d) => d.id)).toEqual(["devicesRead", "devicesWrite", "reports"]);

    // A capability carrying two tags matches either of them — ANY, not ALL.
    const writes = await runtime.describe("direct", { ...options, scope: { tags: ["writes"] } });
    expect(writes.map((d) => d.id)).toEqual(["devicesWrite", "billingWrite"]);
  });

  test("ids select exactly; tags + ids is a union", async () => {
    const { runtime } = taggedRuntime();
    const byId = await runtime.describe("direct", {
      ...options,
      scope: { ids: ["untagged", "reports"] },
    });
    expect(byId.map((d) => d.id)).toEqual(["reports", "untagged"]);

    const union = await runtime.describe("direct", {
      ...options,
      scope: { tags: ["billing"], ids: ["untagged"] },
    });
    expect(union.map((d) => d.id)).toEqual(["billingRead", "billingWrite", "untagged"]);
  });

  test("omitting scope is the identity; so is an object carrying neither key", async () => {
    const { runtime } = taggedRuntime();
    const all = await runtime.describe("direct", options);
    expect(all.map((d) => d.id)).toEqual([
      "devicesRead",
      "devicesWrite",
      "billingRead",
      "billingWrite",
      "reports",
      "untagged",
    ]);
    expect(await runtime.describe("direct", { ...options, scope: {} })).toEqual(all);
    expect(await runtime.describe("direct", { ...options, scope: undefined })).toEqual(all);
  });

  test("a disjoint scope returns empty, never everything", async () => {
    const { runtime } = taggedRuntime();
    expect(await runtime.describe("direct", { ...options, scope: { tags: ["nope"] } })).toEqual([]);
    expect(await runtime.describe("direct", { ...options, scope: { ids: ["nope"] } })).toEqual([]);
    // Present-but-empty is a constraint that matches nothing, not an absent one.
    expect(await runtime.describe("direct", { ...options, scope: { tags: [] } })).toEqual([]);
  });

  test("scope filters BEFORE discovery policies — asserted by evaluation count", async () => {
    const seen: string[] = [];
    const counter = definePolicy(
      "counting",
      ({ capability }) => {
        seen.push(capability.id);
        return allow();
      },
      { phases: ["discovery"] },
    );
    const { runtime } = taggedRuntime([counter]);

    await runtime.describe("direct", { ...options, scope: { tags: ["devices"] } });
    expect(seen).toEqual(["devicesRead", "devicesWrite"]);

    seen.length = 0;
    await runtime.describe("direct", options);
    expect(seen).toHaveLength(6);
  });

  test("scope is not authority: an excluded capability stays invocable (SI-2)", async () => {
    const { runtime } = taggedRuntime();
    const scoped = await runtime.describe("direct", { ...options, scope: { tags: ["devices"] } });
    expect(scoped.map((d) => d.id)).not.toContain("billingRead");

    const result = await runtime.invoke("billingRead", {}, options);
    expect(result.status).toBe("completed");
  });

  test("scope never widens: exposure and hide still decide first", async () => {
    const hideBilling = definePolicy(
      "hide-billing",
      ({ capability }) => (capability.id === "billingRead" ? hide() : allow()),
      { phases: ["discovery"] },
    );
    const { runtime } = taggedRuntime([hideBilling]);
    const scoped = await runtime.describe("direct", {
      ...options,
      scope: { ids: ["billingRead", "billingWrite"] },
    });
    expect(scoped.map((d) => d.id)).toEqual(["billingWrite"]);

    // mcp is exposed nowhere in this registry — scope cannot reach past that.
    expect(await runtime.describe("mcp", { ...options, scope: { tags: ["devices"] } })).toEqual([]);
  });

  test("a malformed scope is a programmer error", async () => {
    const { runtime } = taggedRuntime();
    await expect(
      runtime.describe("direct", { ...options, scope: { tags: "devices" as never } }),
    ).rejects.toThrow(TypeError);
    await expect(
      runtime.describe("direct", { ...options, scope: { ids: [1] as never } }),
    ).rejects.toThrow(TypeError);
    await expect(
      runtime.describe("direct", { ...options, scope: [] as never }),
    ).rejects.toThrow(TypeError);
  });
});

describe("N2 — capabilities.discovered is constant-size", () => {
  test("default payload is count + surface + digest, with no id list", async () => {
    const { runtime, audit } = taggedRuntime();
    await runtime.describe("aiSdk", options);

    const [event] = audit.ofType("capabilities.discovered");
    expect(event!.data.count).toBe(6);
    expect(event!.data.surface).toBe("aiSdk");
    expect(event!.data.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(event!.data.capabilityIds).toBeUndefined();
    expect(Object.keys(event!.data).sort()).toEqual(["count", "digest", "surface"]);
  });

  test("payload size does not grow with the catalog", async () => {
    const size = async (count: number) => {
      const defs: CapabilityDefs = {};
      for (let i = 0; i < count; i++) defs[`cap${i}`] = cap();
      const audit = capturedEvents();
      const runtime = createAgentRuntime({
        governance: defineGovernance({ registry: createCapabilityRegistry(defs) }),
        audit: audit.sink,
      });
      await runtime.describe("direct", options);
      return JSON.stringify(audit.ofType("capabilities.discovered")[0]!.data).length;
    };
    // Only `count` itself grows a digit or two; the 300-capability id array
    // this replaced was ~6 KB.
    expect((await size(300)) - (await size(3))).toBeLessThan(4);
  });

  test("equal catalogs share a digest; a changed catalog changes it", async () => {
    const { runtime, audit } = taggedRuntime();
    await runtime.describe("direct", options);
    await runtime.describe("direct", options);
    await runtime.describe("direct", { ...options, scope: { tags: ["devices"] } });

    const [first, second, scoped] = audit.ofType("capabilities.discovered");
    expect(second!.data.digest).toBe(first!.data.digest);
    expect(scoped!.data.digest).not.toBe(first!.data.digest);
  });

  test("the digest ignores registry order — same ids, same digest", async () => {
    const digestOf = async (defs: CapabilityDefs) => {
      const audit = capturedEvents();
      const runtime = createAgentRuntime({
        governance: defineGovernance({ registry: createCapabilityRegistry(defs) }),
        audit: audit.sink,
      });
      await runtime.describe("direct", options);
      return audit.ofType("capabilities.discovered")[0]!.data.digest;
    };
    expect(await digestOf({ a: cap(), b: cap() })).toBe(await digestOf({ b: cap(), a: cap() }));
    expect(await digestOf({ a: cap(), b: cap() })).not.toBe(await digestOf({ a: cap(), c: cap() }));
  });

  test("verbose audit restores the full id list", async () => {
    const audit = capturedEvents();
    const runtime = createAgentRuntime({
      governance: defineGovernance({ registry: createCapabilityRegistry({ a: cap(), b: cap() }) }),
      audit: { sinks: [audit.sink], verbose: true },
    });
    await runtime.describe("direct", options);
    expect(audit.ofType("capabilities.discovered")[0]!.data.capabilityIds).toEqual(["a", "b"]);
  });
});

describe("N3 — bounded concurrency and a global discovery budget", () => {
  /** Blocks every discovery policy until released, so in-flight is exact. */
  function blockingRuntime(count: number, policyConcurrency?: number) {
    let inFlight = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocking = definePolicy(
      "blocking",
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await gate;
        inFlight--;
        return allow();
      },
      { phases: ["discovery"] },
    );

    const defs: CapabilityDefs = {};
    for (let i = 0; i < count; i++) defs[`cap${i}`] = cap();
    const runtime = createAgentRuntime({
      governance: defineGovernance({
        registry: createCapabilityRegistry(defs),
        policies: [blocking],
      }),
      ...(policyConcurrency === undefined ? {} : { defaults: { policyConcurrency } }),
    });
    return { runtime, release, current: () => inFlight, peak: () => peak };
  }

  test("evaluates up to policyConcurrency capabilities at once (default 16)", async () => {
    const { runtime, release, current, peak } = blockingRuntime(40);
    const pending = runtime.describe("direct", options);

    expect(current()).toBe(16);
    release();
    const descriptors = await pending;

    expect(peak()).toBe(16);
    expect(descriptors).toHaveLength(40);
  });

  test("policyConcurrency: 1 restores serial evaluation", async () => {
    const { runtime, release, peak } = blockingRuntime(40, 1);
    const pending = runtime.describe("direct", options);
    release();
    await pending;
    expect(peak()).toBe(1);
  });

  test("descriptor order stays registry order regardless of completion order", async () => {
    const slowFirst = definePolicy(
      "uneven",
      async ({ capability }) => {
        if (capability.id === "a") await new Promise((r) => setTimeout(r, 20));
        return allow();
      },
      { phases: ["discovery"] },
    );
    const registry = createCapabilityRegistry({ a: cap(), b: cap(), c: cap() });
    const runtime = createAgentRuntime({
      governance: defineGovernance({ registry, policies: [slowFirst] }),
    });
    expect((await runtime.describe("direct", options)).map((d) => d.id)).toEqual(["a", "b", "c"]);
  });

  test("a failing policy excludes its own capability only (SI-7 under concurrency)", async () => {
    const explode = definePolicy(
      "explode-on-b",
      async ({ capability }) => {
        if (capability.id === "b") throw new Error("boom");
        return allow();
      },
      { phases: ["discovery"] },
    );
    const registry = createCapabilityRegistry({ a: cap(), b: cap(), c: cap() });
    const runtime = createAgentRuntime({
      governance: defineGovernance({ registry, policies: [explode] }),
    });
    expect((await runtime.describe("direct", options)).map((d) => d.id)).toEqual(["a", "c"]);
  });

  test("budget expiry throws TIMEOUT rather than returning a short catalog", async () => {
    const slow = definePolicy("slow", () => new Promise<never>(() => {}), {
      phases: ["discovery"],
    });
    const audit = capturedEvents();
    const registry = createCapabilityRegistry({ a: cap(), b: cap(), c: cap() });
    const runtime = createAgentRuntime({
      governance: defineGovernance({ registry, policies: [slow] }),
      audit: audit.sink,
      defaults: { discoveryBudgetMs: 25, policyTimeoutMs: 30_000, policyConcurrency: 1 },
    });

    const error = await runtime.describe("direct", options).catch((e: unknown) => e);
    if (!isCapabilityError(error)) expect.unreachable();
    expect(error.code).toBe("TIMEOUT");
    expect(error.stage).toBe("discovery");
    // No partial result, and nothing claiming a catalog was produced.
    expect(audit.ofType("capabilities.discovered")).toHaveLength(0);
  });

  test("the budget bounds the whole discovery, not one capability's batch", async () => {
    const slow = definePolicy("slow", () => new Promise<never>(() => {}), {
      phases: ["discovery"],
    });
    const registry = createCapabilityRegistry({ a: cap(), b: cap(), c: cap(), d: cap() });
    const runtime = createAgentRuntime({
      governance: defineGovernance({ registry, policies: [slow] }),
      // Serial batches: 4 × 5_000 without a global budget.
      defaults: { discoveryBudgetMs: 40, policyTimeoutMs: 5_000, policyConcurrency: 1 },
    });

    const started = performance.now();
    await expect(runtime.describe("direct", options)).rejects.toThrow(/discovery/i);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
