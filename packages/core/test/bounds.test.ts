import { describe, expect, test } from "vitest";
import { os } from "@orpc/server";
import * as z from "zod";
import { createAgentRuntime } from "../src/runtime/create";
import { defineGovernance } from "../src/governance";
import { createCapabilityRegistry } from "../src/registry";
import { agentProcedure } from "../src/procedure";
import { CapabilityError } from "../src/errors";
import { capturedEvents, dana } from "./helpers";
import type { AgentMeta } from "../src/meta";

const base = agentProcedure(os.$context<object>());
const options = { actor: dana, context: {} };

function slowCapability(meta: Partial<AgentMeta>, behavior?: "honor-signal" | "ignore-signal") {
  return base
    .meta({
      agent: {
        description: "Slow.",
        expose: { direct: true, test: true },
        sideEffect: "read",
        risk: "low",
        ...meta,
      },
    })
    .input(z.object({}))
    .handler(({ signal }) => {
      if (behavior === "ignore-signal") {
        return new Promise((resolve) => setTimeout(() => resolve({ late: true }), 200));
      }
      return new Promise((_, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
}

describe("bounded execution (SI-12)", () => {
  test("timeout: cancelled envelope, TIMEOUT code, signal reaches the handler", async () => {
    const audit = capturedEvents();
    const registry = createCapabilityRegistry({
      slow: slowCapability({ timeoutMs: 25 }),
    });
    const runtime = createAgentRuntime({ governance: defineGovernance({ registry }), audit: audit.sink });
    const result = await runtime.invoke("slow", {}, options);
    expect(result.status).toBe("cancelled");
    if (result.status === "cancelled") {
      expect(result.error.code).toBe("TIMEOUT");
      expect(result.error.stage).toBe("timeout");
      expect(result.error.retryable).toBe(true);
    }
    expect(audit.types()).toEqual([
      "capability.requested",
      "capability.started",
      "capability.cancelled",
    ]);
    expect(audit.ofType("capability.cancelled")[0]!.data.code).toBe("TIMEOUT");
  });

  test("caller cancellation: CANCELLED, distinct from timeout, not retryable", async () => {
    const registry = createCapabilityRegistry({ slow: slowCapability({ timeoutMs: 5_000 }) });
    const runtime = createAgentRuntime({ governance: defineGovernance({ registry }) });
    const controller = new AbortController();
    const pending = runtime.invoke("slow", {}, { ...options, signal: controller.signal });
    setTimeout(() => controller.abort(new Error("user left")), 20);
    const result = await pending;
    expect(result.status).toBe("cancelled");
    if (result.status === "cancelled") {
      expect(result.error.code).toBe("CANCELLED");
      expect(result.error.stage).toBe("cancellation");
      expect(result.error.retryable).toBe(false);
    }
  });

  test("already-aborted caller signal cancels before execution", async () => {
    let ran = false;
    const cap = base
      .meta({
        agent: {
          description: "x",
          expose: { direct: true },
          sideEffect: "read",
          risk: "low",
        },
      })
      .input(z.object({}))
      .handler(async () => {
        ran = true;
        return {};
      });
    const registry = createCapabilityRegistry({ cap });
    const runtime = createAgentRuntime({ governance: defineGovernance({ registry }) });
    const controller = new AbortController();
    controller.abort();
    const result = await runtime.invoke("cap", {}, { ...options, signal: controller.signal });
    expect(result.status).toBe("cancelled");
    expect(ran).toBe(false);
  });

  test("late completion of a signal-ignoring handler is not consumed", async () => {
    const registry = createCapabilityRegistry({
      ignores: slowCapability({ timeoutMs: 25 }, "ignore-signal"),
    });
    const runtime = createAgentRuntime({ governance: defineGovernance({ registry }) });
    const result = await runtime.invoke("ignores", {}, options);
    expect(result.status).toBe("cancelled");
    if (result.status === "cancelled") expect(result.error.code).toBe("TIMEOUT");
    expect((result as { output?: unknown }).output).toBeUndefined();
    // Allow the late handler to finish so no unhandled rejection leaks.
    await new Promise((resolve) => setTimeout(resolve, 220));
  });
});

describe("retry eligibility (SI-11)", () => {
  function flaky(meta: Partial<AgentMeta>, failures: number, error?: () => unknown) {
    let calls = 0;
    const capability = base
      .meta({
        agent: {
          description: "Flaky.",
          expose: { direct: true },
          sideEffect: "read",
          risk: "low",
          retry: { maxAttempts: 2, backoffMs: 1 },
          ...meta,
        },
      })
      .input(z.object({}))
      .handler(async () => {
        calls += 1;
        if (calls <= failures) {
          throw error
            ? error()
            : new CapabilityError({ code: "EXECUTION_FAILED", retryable: true });
        }
        return { calls };
      });
    return { capability, calls: () => calls };
  }

  test("read + retryable: retried with same executionId and capability.retried events", async () => {
    const audit = capturedEvents();
    const { capability } = flaky({}, 2);
    const registry = createCapabilityRegistry({ cap: capability });
    const runtime = createAgentRuntime({ governance: defineGovernance({ registry }), audit: audit.sink });
    const result = await runtime.invoke("cap", {}, options);
    expect(result.status).toBe("completed");
    if (result.status === "completed") expect((result.output as { calls: number }).calls).toBe(3);

    expect(audit.types()).toEqual([
      "capability.requested",
      "capability.started",
      "capability.retried",
      "capability.retried",
      "capability.completed",
    ]);
    const executionIds = new Set(audit.events().map((e) => e.executionId));
    expect(executionIds.size).toBe(1);
    expect(audit.ofType("capability.retried").map((e) => e.data.attempt)).toEqual([2, 3]);
    expect(audit.ofType("capability.retried")[0]!.data.previousErrorCode).toBe("EXECUTION_FAILED");
    expect(audit.ofType("capability.completed")[0]!.data.attempts).toBe(3);
  });

  test("attempts are bounded by maxAttempts", async () => {
    const { capability, calls } = flaky({ retry: { maxAttempts: 1, backoffMs: 1 } }, 99);
    const registry = createCapabilityRegistry({ cap: capability });
    const runtime = createAgentRuntime({ governance: defineGovernance({ registry }) });
    const result = await runtime.invoke("cap", {}, options);
    expect(result.status).toBe("failed");
    expect(calls()).toBe(2);
  });

  test("non-retryable errors are not retried", async () => {
    const { capability, calls } = flaky({}, 99, () => new Error("plain failure"));
    const registry = createCapabilityRegistry({ cap: capability });
    const runtime = createAgentRuntime({ governance: defineGovernance({ registry }) });
    const result = await runtime.invoke("cap", {}, options);
    expect(result.status).toBe("failed");
    expect(calls()).toBe(1);
  });

  test("writes without retry config are never auto-retried even on retryable errors", async () => {
    const { capability, calls } = flaky({ sideEffect: "write", retry: undefined }, 99);
    const registry = createCapabilityRegistry({ cap: capability });
    const runtime = createAgentRuntime({ governance: defineGovernance({ registry }) });
    const result = await runtime.invoke("cap", {}, options);
    expect(result.status).toBe("failed");
    expect(calls()).toBe(1);
  });

  test("write + idempotent + explicit retry config: retried", async () => {
    const { capability, calls } = flaky(
      { sideEffect: "write", idempotent: true, retry: { maxAttempts: 2, backoffMs: 1 } },
      1,
    );
    const registry = createCapabilityRegistry({ cap: capability });
    const runtime = createAgentRuntime({ governance: defineGovernance({ registry }) });
    const result = await runtime.invoke("cap", {}, options);
    expect(result.status).toBe("completed");
    expect(calls()).toBe(2);
  });

  test("retryOn predicate can veto retries", async () => {
    const { capability, calls } = flaky(
      { retry: { maxAttempts: 2, backoffMs: 1, retryOn: () => false } },
      99,
    );
    const registry = createCapabilityRegistry({ cap: capability });
    const runtime = createAgentRuntime({ governance: defineGovernance({ registry }) });
    await runtime.invoke("cap", {}, options);
    expect(calls()).toBe(1);
  });

  test("timed-out reads with retry config are retried with a fresh timer", async () => {
    let calls = 0;
    const capability = base
      .meta({
        agent: {
          description: "Slow then fast.",
          expose: { direct: true },
          sideEffect: "read",
          risk: "low",
          timeoutMs: 40,
          retry: { maxAttempts: 1, backoffMs: 1 },
        },
      })
      .input(z.object({}))
      .handler(({ signal }) => {
        calls += 1;
        if (calls === 1) {
          return new Promise((_, reject) =>
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
          );
        }
        return Promise.resolve({ calls });
      });
    const audit = capturedEvents();
    const registry = createCapabilityRegistry({ cap: capability });
    const runtime = createAgentRuntime({ governance: defineGovernance({ registry }), audit: audit.sink });
    const result = await runtime.invoke("cap", {}, options);
    expect(result.status).toBe("completed");
    expect(calls).toBe(2);
    expect(audit.ofType("capability.retried")[0]!.data.previousErrorCode).toBe("TIMEOUT");
  });

  test("timed-out writes are not retried (SI-11) even though TIMEOUT is retryable", async () => {
    let calls = 0;
    const capability = base
      .meta({
        agent: {
          description: "Slow write.",
          expose: { direct: true },
          sideEffect: "write",
          risk: "high",
          timeoutMs: 25,
        },
      })
      .input(z.object({}))
      .handler(({ signal }) => {
        calls += 1;
        return new Promise((_, reject) =>
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
      });
    const registry = createCapabilityRegistry({ cap: capability });
    const runtime = createAgentRuntime({ governance: defineGovernance({ registry }) });
    const result = await runtime.invoke("cap", {}, options);
    expect(result.status).toBe("cancelled");
    if (result.status === "cancelled") expect(result.error.code).toBe("TIMEOUT");
    expect(calls).toBe(1);
  });

  test("idempotencyKey is stable across retry attempts", async () => {
    const keys: string[] = [];
    let calls = 0;
    const capability = base
      .meta({
        agent: {
          description: "x",
          expose: { direct: true },
          sideEffect: "read",
          risk: "low",
          retry: { maxAttempts: 1, backoffMs: 1 },
        },
      })
      .input(z.object({}))
      .handler(async ({ context }) => {
        keys.push((context as { agent: { idempotencyKey: string } }).agent.idempotencyKey);
        calls += 1;
        if (calls === 1) throw new CapabilityError({ code: "EXECUTION_FAILED", retryable: true });
        return {};
      });
    const registry = createCapabilityRegistry({ cap: capability });
    const runtime = createAgentRuntime({ governance: defineGovernance({ registry }) });
    await runtime.invoke("cap", {}, options);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });
});
