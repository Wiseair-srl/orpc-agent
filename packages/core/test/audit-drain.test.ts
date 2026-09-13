import { expect, test } from "vitest";
import { createAuditEmitter } from "../src/runtime/audit";
import type { AgentAuditEvent } from "../src/events";
const event: AgentAuditEvent = { type: "capabilities.discovered", timestamp: new Date(), surface: "aiSdk", actor: { id: "one", kind: "user" }, data: { count: 0, surface: "aiSdk", digest: "empty" } };
test("request drain waits for its writes and reports off-path failures", async () => {
  let release!: () => void;
  const emitter = createAuditEmitter({ sinks: [() => new Promise((resolve) => { release = resolve; })] });
  emitter.emit(event);
  await Promise.resolve();
  let done = false;
  const draining = emitter.drain().then(() => { done = true; });
  await Promise.resolve();
  expect(done).toBe(false);
  release();
  await draining;
  const failing = createAuditEmitter({ sinks: [async () => { throw new Error("no delivery"); }], onSinkError: () => {} });
  failing.emit(event);
  await expect(failing.drain()).rejects.toThrow("Audit delivery failed");
});
test("request drain is bounded and does not wait for another emitter", async () => {
  const stalled = createAuditEmitter(() => new Promise(() => {}));
  stalled.emit(event);
  await expect(stalled.drain({ timeoutMs: 10 })).rejects.toThrow("timed out");
  await expect(createAuditEmitter(async () => {}).drain()).resolves.toBeUndefined();
});
test("immediate emit then drain flushes a batching sink before its long timer", async () => {
  let pending: (() => void) | undefined;
  const sink = Object.assign(() => new Promise<void>((resolve) => { pending = resolve; }), {
    flush: async () => { pending?.(); },
  });
  const emitter = createAuditEmitter(sink);
  emitter.emit(event);
  await expect(emitter.drain({ timeoutMs: 50 })).resolves.toBeUndefined();
});
