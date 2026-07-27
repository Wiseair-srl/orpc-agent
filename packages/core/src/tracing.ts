/**
 * Neutral tracing interface. Core calls this; `@orpc-agent/opentelemetry`
 * implements it on real OTel spans. Without an adapter, span calls are no-ops.
 */

export type SpanAttributes = Record<string, string | number | boolean>;

export interface SpanHandle {
  setAttributes(attributes: SpanAttributes): void;
  recordError(error: unknown): void;
  end(status: "ok" | "error"): void;
}

export interface TracingAdapter {
  startSpan(name: string, attributes: SpanAttributes, parent?: SpanHandle): SpanHandle;
}

export const NOOP_SPAN: SpanHandle = {
  setAttributes() {},
  recordError() {},
  end() {},
};

export const NOOP_TRACING: TracingAdapter = {
  startSpan: () => NOOP_SPAN,
};
