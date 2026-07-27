import {
  SpanStatusCode,
  context as otelContext,
  trace,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import type { SpanAttributes, SpanHandle, TracingAdapter } from "@orpc-agent/core";

/**
 * Implements core's neutral TracingAdapter on @opentelemetry/api. The
 * application owns its OTel SDK setup; this package only creates spans and
 * inherits whatever SDK is registered (no SDK → API no-ops).
 */

export type OpenTelemetryTracingOptions = {
  /** Bring your own tracer/instrumentation scope. Default: trace.getTracer("orpc-agent"). */
  tracer?: Tracer;
  /**
   * When true, keeps `orpc_agent.actor_id` on spans. Off by default: trace
   * backends often have wider read access than audit stores (SI-10-adjacent).
   */
  actorIdAttribute?: boolean;
};

const ACTOR_ID_ATTRIBUTE = "orpc_agent.actor_id";

export function createOpenTelemetryTracing(
  options?: OpenTelemetryTracingOptions,
): TracingAdapter {
  const tracer = options?.tracer ?? trace.getTracer("orpc-agent");
  const includeActorId = options?.actorIdAttribute ?? false;

  const filterAttributes = (attributes: SpanAttributes): SpanAttributes => {
    if (includeActorId) return attributes;
    if (!(ACTOR_ID_ATTRIBUTE in attributes)) return attributes;
    const { [ACTOR_ID_ATTRIBUTE]: _dropped, ...rest } = attributes;
    return rest;
  };

  const toHandle = (span: Span): SpanHandle & { span: Span } => ({
    span,
    setAttributes(attributes) {
      span.setAttributes(filterAttributes(attributes));
    },
    recordError(error) {
      span.recordException(
        error instanceof Error ? error : new Error(String(error)),
      );
    },
    end(status) {
      span.setStatus({
        code: status === "error" ? SpanStatusCode.ERROR : SpanStatusCode.OK,
      });
      span.end();
    },
  });

  return {
    startSpan(name, attributes, parent) {
      // Parent explicitly on the given handle, else on the ACTIVE OTel
      // context — so agent.capability_call lands under the app's HTTP/AI SDK
      // spans automatically.
      const parentSpan = (parent as { span?: Span } | undefined)?.span;
      const ctx = parentSpan
        ? trace.setSpan(otelContext.active(), parentSpan)
        : otelContext.active();
      const span = tracer.startSpan(name, { attributes: filterAttributes(attributes) }, ctx);
      return toHandle(span);
    },
  };
}
