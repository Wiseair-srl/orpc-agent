# @orpc-agent/core

## 0.2.0

### Minor Changes

- 53b20a9: Startup footgun warnings (ADR-014): `createAgentRuntime` warns when approval-gated capabilities run on the default in-memory coordinator without an inline handler, and when write-capable capabilities are exposed to model surfaces with no audit sink; `warnings: false` silences. Schema-conversion cache is invalidated on `registerSchemaConverter`, and `describe` clones cached conversions into descriptors so callers cannot poison the cache.
