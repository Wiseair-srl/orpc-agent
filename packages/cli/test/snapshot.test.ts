import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildSnapshot } from "../src/snapshot";
import { canonicalJson, snapshotJson } from "../src/canonical";
import { alwaysAllow, procedure, registryOf } from "./fixtures";

describe("buildSnapshot", () => {
  it("records only surfaces exposed with exactly true", () => {
    const registry = registryOf({
      a: procedure({ expose: { aiSdk: true, mcp: false } }),
      b: procedure({ expose: { aiSdk: true, mcp: true, direct: true } }),
    });

    const snapshot = buildSnapshot(registry);

    expect(snapshot.capabilities[0]?.expose).toEqual(["aiSdk"]);
    expect(snapshot.capabilities[1]?.expose).toEqual(["aiSdk", "direct", "mcp"]);
  });

  it("serializes an explicit false and an absent surface identically", () => {
    const withFalse = buildSnapshot(registryOf({ a: procedure({ expose: { aiSdk: true, mcp: false } }) }));
    const withAbsent = buildSnapshot(registryOf({ a: procedure({ expose: { aiSdk: true } }) }));

    expect(snapshotJson(withFalse)).toBe(snapshotJson(withAbsent));
  });

  it("derives tool names only for exposed schema surfaces, honouring meta overrides", () => {
    const registry = registryOf({
      orders: {
        refund: procedure({
          expose: { aiSdk: true, mcp: true, direct: true },
          adapters: { mcp: { toolName: "refund_an_order" } },
        }),
      },
      internal: { ping: procedure({ expose: { direct: true } }) },
    });

    const [internalPing, ordersRefund] = buildSnapshot(registry).capabilities;

    expect(ordersRefund?.toolNames).toEqual({ aiSdk: "orders_refund", mcp: "refund_an_order" });
    expect(internalPing?.toolNames).toBeUndefined();
  });

  it("sorts capabilities and tags but preserves policy declaration order", () => {
    const second = { ...alwaysAllow, name: "second" };
    const registry = registryOf({
      zeta: procedure({ tags: ["b", "a"], policies: [alwaysAllow, second] }),
      alpha: procedure({}),
    });

    const snapshot = buildSnapshot(registry);

    expect(snapshot.capabilities.map((c) => c.id)).toEqual(["alpha", "zeta"]);
    expect(snapshot.capabilities[1]?.tags).toEqual(["a", "b"]);
    expect(snapshot.capabilities[1]?.policies).toEqual(["always-allow", "second"]);
  });

  it("reduces functions to presence flags", () => {
    const registry = registryOf({
      a: procedure({
        redact: { output: (o) => o },
        retry: { maxAttempts: 2, retryOn: () => true },
      }),
    });

    const [first] = buildSnapshot(registry).capabilities;

    expect(first?.redact).toEqual({ output: true, approvalInput: false });
    expect(first?.retry).toEqual({ maxAttempts: 2, retryOn: true });
  });

  it("lists procedures without meta.agent as excluded, and staged capabilities as unexposed", () => {
    const registry = registryOf({
      plain: procedure(undefined),
      staged: procedure({ expose: {} }),
      live: procedure({}),
    });

    const snapshot = buildSnapshot(registry);

    expect(snapshot.excluded).toEqual(["plain"]);
    expect(snapshot.unexposed).toEqual(["staged"]);
    expect(snapshot.capabilities.map((c) => c.id)).toEqual(["live", "staged"]);
  });

  it("hashes input schemas and reports no input as null", () => {
    const registry = registryOf({
      withInput: procedure({}, z.object({ id: z.string() })),
      withoutInput: procedure({}),
    });

    const [withInput, withoutInput] = buildSnapshot(registry).capabilities;

    expect(withInput?.inputSchemaHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(withoutInput?.inputSchemaHash).toBeNull();
  });

  it("gives the same hash for the same schema shape and a different one when it changes", () => {
    const same = buildSnapshot(registryOf({ a: procedure({}, z.object({ id: z.string() })) }));
    const alsoSame = buildSnapshot(registryOf({ a: procedure({}, z.object({ id: z.string() })) }));
    const different = buildSnapshot(
      registryOf({ a: procedure({}, z.object({ id: z.string(), extra: z.number() })) }),
    );

    expect(same.capabilities[0]?.inputSchemaHash).toBe(alsoSame.capabilities[0]?.inputSchemaHash);
    expect(same.capabilities[0]?.inputSchemaHash).not.toBe(
      different.capabilities[0]?.inputSchemaHash,
    );
  });

  it("omits descriptions when asked", () => {
    const registry = registryOf({ a: procedure({}) });

    expect(buildSnapshot(registry, { descriptions: false }).capabilities[0]?.description).toBeUndefined();
    expect(buildSnapshot(registry).capabilities[0]?.description).toBe("does a thing");
  });

  it("is byte-identical across builds of the same registry", () => {
    const registry = registryOf({
      b: procedure({ tags: ["z", "a"] }, z.object({ id: z.string() })),
      a: procedure({ expose: { mcp: true, aiSdk: true } }),
    });

    expect(snapshotJson(buildSnapshot(registry))).toBe(snapshotJson(buildSnapshot(registry)));
  });
});

describe("canonicalJson", () => {
  it("is insensitive to key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it("keeps array order, which carries meaning", () => {
    expect(canonicalJson(["b", "a"])).not.toBe(canonicalJson(["a", "b"]));
  });
});
