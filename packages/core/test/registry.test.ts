import { describe, expect, test } from "vitest";
import { eventIterator, lazy, os } from "@orpc/server";
import * as z from "zod";
import { createCapabilityRegistry } from "../src/registry";
import { agentBase, internalRecompute, readMeta, refundOrder, searchOrders } from "./fixtures";
import type { AgentMeta } from "../src/meta";

function proc(meta: unknown) {
  return agentBase
    .meta({ agent: meta as never })
    .input(z.object({ q: z.string() }))
    .handler(async () => ({ ok: true }));
}

describe("id derivation and inclusion", () => {
  test("dot-joined path ids in declaration order", () => {
    const registry = createCapabilityRegistry({
      customers: { search: searchOrders, get: searchOrders },
      orders: { search: searchOrders, refund: refundOrder },
    });
    expect(registry.ids()).toEqual([
      "customers.search",
      "customers.get",
      "orders.search",
      "orders.refund",
    ]);
    expect(registry.get("orders.refund")?.path).toEqual(["orders", "refund"]);
    expect(registry.get("orders.refund")?.meta.risk).toBe("high");
    expect(registry.get("nope")).toBeUndefined();
  });

  test("procedures without agent meta are excluded and reported, never included", () => {
    const registry = createCapabilityRegistry({
      orders: { search: searchOrders },
      internal: { recompute: internalRecompute },
    });
    expect(registry.ids()).toEqual(["orders.search"]);
    expect(registry.inspect().excluded).toEqual([
      { path: "internal.recompute", reason: "no-agent-meta" },
    ]);
  });

  test("normalized meta resolves collection defaults", () => {
    const registry = createCapabilityRegistry({ orders: { search: searchOrders } });
    const meta = registry.get("orders.search")!.meta;
    expect(meta.policies).toEqual([]);
    expect(meta.idempotent).toBe(false);
  });

  test("inspect flags capabilities exposed nowhere", () => {
    const registry = createCapabilityRegistry({
      staged: proc(readMeta({ expose: {} })),
    });
    expect(registry.ids()).toEqual(["staged"]);
    expect(registry.inspect().unexposed).toEqual(["staged"]);
  });
});

describe("metadata validation matrix", () => {
  const required: [string, Partial<Record<keyof AgentMeta, unknown>>][] = [
    ["description", { description: undefined }],
    ["expose", { expose: undefined }],
    ["sideEffect", { sideEffect: undefined }],
    ["risk", { risk: undefined }],
  ];

  test.each(required)("omitting required %s fails at build", (field, override) => {
    const meta = { ...readMeta(), ...override };
    delete (meta as Record<string, unknown>)[field];
    expect(() => createCapabilityRegistry({ cap: proc(meta) })).toThrowError(
      new RegExp(`"cap".*"?${field}"?`),
    );
  });

  test.each(["write", "destructive", "external"] as const)(
    "retry on %s without idempotent is rejected",
    (sideEffect) => {
      const meta = readMeta({ sideEffect, retry: { maxAttempts: 2 } });
      expect(() => createCapabilityRegistry({ cap: proc(meta) })).toThrowError(/SI-11/);
      // With idempotent: true it passes.
      expect(() =>
        createCapabilityRegistry({
          cap: proc(readMeta({ sideEffect, retry: { maxAttempts: 2 }, idempotent: true })),
        }),
      ).not.toThrow();
    },
  );

  test("retry on reads needs no idempotency declaration", () => {
    expect(() =>
      createCapabilityRegistry({ cap: proc(readMeta({ retry: { maxAttempts: 2 } })) }),
    ).not.toThrow();
  });

  test("unknown expose surface keys are rejected", () => {
    expect(() =>
      createCapabilityRegistry({ cap: proc(readMeta({ expose: { http: true } as never })) }),
    ).toThrowError(/unknown surface "http"/);
  });

  test("non-positive timeoutMs and expiresInMs are rejected", () => {
    expect(() =>
      createCapabilityRegistry({ cap: proc(readMeta({ timeoutMs: 0 })) }),
    ).toThrowError(/timeoutMs/);
    expect(() =>
      createCapabilityRegistry({
        cap: proc(readMeta({ approval: { required: true, expiresInMs: -5 } })),
      }),
    ).toThrowError(/expiresInMs/);
  });

  test("toolName collisions after name mapping fail at build", () => {
    const a = proc(readMeta({ expose: { aiSdk: true }, adapters: { aiSdk: { toolName: "x" } } }));
    const b = proc(readMeta({ expose: { aiSdk: true }, adapters: { aiSdk: { toolName: "x" } } }));
    expect(() => createCapabilityRegistry({ a, b })).toThrowError(/tool name collision/);
  });

  test("default-mapped names can collide too", () => {
    const one = proc(readMeta({ expose: { mcp: true } }));
    const two = proc(readMeta({ expose: { mcp: true } }));
    expect(() =>
      createCapabilityRegistry({ a: { b: one }, ["a.b" as string]: two }),
    ).toThrowError(/must not contain "\."/);
    // Same mapped name via explicit override vs default mapping.
    const three = proc(
      readMeta({ expose: { mcp: true }, adapters: { mcp: { toolName: "a_b" } } }),
    );
    expect(() => createCapabilityRegistry({ a: { b: one }, c: three })).toThrowError(
      /collision on surface "mcp".*"a_b"/,
    );
  });

  test("collisions on unexposed surfaces are not errors", () => {
    const a = proc(readMeta({ adapters: { aiSdk: { toolName: "x" } } }));
    const b = proc(readMeta({ adapters: { aiSdk: { toolName: "x" } } }));
    expect(() => createCapabilityRegistry({ a, b })).not.toThrow();
  });

  test("all problems are aggregated into one startup error", () => {
    const bad1 = proc({ description: "x", expose: { direct: true } }); // missing sideEffect+risk
    const bad2 = proc(readMeta({ sideEffect: "write", retry: { maxAttempts: 1 } }));
    try {
      createCapabilityRegistry({ bad1, bad2 });
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/Capability registry validation failed \(3 problems\)/);
      expect(message).toMatch(/"bad1": missing or invalid required "sideEffect"/);
      expect(message).toMatch(/"bad1": missing or invalid required "risk"/);
      expect(message).toMatch(/"bad2": retry configured/);
    }
  });

  test("event-iterator procedures are rejected with a clear error", () => {
    const streaming = agentBase
      .meta({ agent: readMeta() })
      .input(z.object({}))
      .output(eventIterator(z.object({ chunk: z.string() })))
      .handler(async function* () {
        yield { chunk: "hi" };
      });
    expect(() => createCapabilityRegistry({ streaming })).toThrowError(/event-iterator/);
  });

  test("lazy values are rejected with a clear error", () => {
    const lazyProc = lazy(() => Promise.resolve({ default: searchOrders }));
    expect(() =>
      createCapabilityRegistry({ lazyProc: lazyProc as never }),
    ).toThrowError(/lazy/);
  });

  test("junk leaf values are rejected", () => {
    expect(() => createCapabilityRegistry({ junk: 42 as never })).toThrowError(
      /not an oRPC procedure/,
    );
  });

  test("contract-only procedures are rejected", () => {
    const contractish = os.$context<object>().input(z.object({}));
    expect(() =>
      createCapabilityRegistry({ contractish: contractish as never }),
    ).toThrowError(/not an oRPC procedure|not an implemented procedure/);
  });
});

describe("filter", () => {
  const registry = createCapabilityRegistry({
    orders: { search: searchOrders, refund: refundOrder },
  });

  test("by surface", () => {
    expect(registry.filter({ surface: "aiSdk" }).ids()).toEqual(["orders.refund"]);
  });

  test("by side effect and risk (any-of)", () => {
    expect(registry.filter({ sideEffect: ["none", "read"] }).ids()).toEqual(["orders.search"]);
    expect(registry.filter({ risk: ["high", "critical"] }).ids()).toEqual(["orders.refund"]);
  });

  test("by tags (any-of)", () => {
    expect(registry.filter({ tags: ["money"] }).ids()).toEqual(["orders.refund"]);
  });

  test("by predicate; filtering composes and originals are immutable", () => {
    const narrowed = registry.filter((c) => c.meta.sideEffect === "read").filter({ tags: ["orders"] });
    expect(narrowed.ids()).toEqual(["orders.search"]);
    expect(registry.ids()).toHaveLength(2);
    expect(narrowed.inspect().excluded).toEqual(registry.inspect().excluded);
  });
});
