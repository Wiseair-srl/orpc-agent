import type { AgentAuditEvent, AuditSink } from "../events";
import type { AuditConfig } from "./types";

export type AuditEmitter = {
  emit(event: AgentAuditEvent): void;
  emitAwaited(event: AgentAuditEvent): Promise<void>;
  /** Request runtimes own their emitter; shared sinks may own connection pools. */
  drain(options?: { timeoutMs?: number }): Promise<void>;
  readonly strict: boolean;
  readonly verbose: boolean;
  readonly hasSinks: boolean;
};

export function createAuditEmitter(config: AuditConfig | undefined): AuditEmitter {
  let sinks: AuditSink[] = [];
  let strict = false;
  let verbose = false;
  let onSinkError: ((err: unknown, event: AgentAuditEvent) => void) | undefined;
  if (typeof config === "function") sinks = [config];
  else if (Array.isArray(config)) sinks = config;
  else if (config !== undefined) {
    sinks = config.sinks ?? [];
    strict = config.strict ?? false;
    verbose = config.verbose ?? false;
    onSinkError = config.onSinkError;
  }
  const pending = new Set<Promise<void>>();
  const failures: unknown[] = [];
  const write = (sink: AuditSink, event: AgentAuditEvent): Promise<void> => {
    let result: Promise<void>;
    try { result = Promise.resolve(sink(event)); }
    catch (error) { result = Promise.reject(error); }
    pending.add(result);
    void result.then(() => pending.delete(result), (err) => {
      pending.delete(result);
      failures.push(err);
      try {
        if (onSinkError) onSinkError(err, event);
        else console.error("[orpc-agent] audit sink failed for event", event.type, err);
      } catch { /* Error reporting must never fail business execution. */ }
    });
    return result;
  };
  return {
    strict, verbose, hasSinks: sinks.length > 0,
    emit(event) { for (const sink of sinks) void write(sink, event); },
    async emitAwaited(event) { await Promise.all(sinks.map((sink) => write(sink, event))); },
    async drain({ timeoutMs = 5_000 } = {}) {
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("drainAudit: timeoutMs must be positive");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            // Flush optional batching sinks before joining the request's own writes.
            await Promise.all(sinks.map((sink) => (sink as AuditSink & { flush?: () => Promise<void> }).flush?.()));
            while (pending.size) await Promise.allSettled([...pending]);
            if (failures.length) throw new AggregateError(failures.splice(0), "Audit delivery failed");
          })(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Audit drain timed out")), timeoutMs); }),
        ]);
      } finally { if (timer !== undefined) clearTimeout(timer); }
    },
  };
}
