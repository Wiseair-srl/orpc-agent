import type { AgentAuditEvent, AuditSink } from "../events";
import type { AuditConfig } from "./types";

export type AuditEmitter = {
  /** Best-effort: sink results are awaited off the critical path. */
  emit(event: AgentAuditEvent): void;
  /** Awaits every sink; rejects with the first sink failure (strict mode). */
  emitAwaited(event: AgentAuditEvent): Promise<void>;
  readonly strict: boolean;
  /** Emitters add catalog-sized payloads only when this is on. */
  readonly verbose: boolean;
  readonly hasSinks: boolean;
};

export function createAuditEmitter(config: AuditConfig | undefined): AuditEmitter {
  let sinks: AuditSink[] = [];
  let strict = false;
  let verbose = false;
  let onSinkError: ((err: unknown, event: AgentAuditEvent) => void) | undefined;

  if (typeof config === "function") {
    sinks = [config];
  } else if (Array.isArray(config)) {
    sinks = config;
  } else if (config !== undefined) {
    sinks = config.sinks ?? [];
    strict = config.strict ?? false;
    verbose = config.verbose ?? false;
    onSinkError = config.onSinkError;
  }

  const reportSinkError = (err: unknown, event: AgentAuditEvent) => {
    if (onSinkError) {
      try {
        onSinkError(err, event);
      } catch {
        // An error handler that itself throws is dropped; never fail execution.
      }
    } else {
      console.error("[orpc-agent] audit sink failed for event", event.type, err);
    }
  };

  return {
    strict,
    verbose,
    hasSinks: sinks.length > 0,
    emit(event) {
      for (const sink of sinks) {
        try {
          const result = sink(event);
          if (result && typeof (result as Promise<void>).catch === "function") {
            (result as Promise<void>).catch((err) => reportSinkError(err, event));
          }
        } catch (err) {
          reportSinkError(err, event);
        }
      }
    },
    async emitAwaited(event) {
      await Promise.all(sinks.map((sink) => Promise.resolve(sink(event))));
    },
  };
}
