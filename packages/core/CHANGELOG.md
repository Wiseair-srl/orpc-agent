# @orpc-agent/core

## 0.3.0

### Minor Changes

- e3469e7: New package `@orpc-agent/cli` — capability inventory and CI drift gate (ADR-015).

  The binary `orpc-agent` answers two questions about a repository: what an agent can reach from it, and whether that changed in a pull request.

  - `orpc-agent inspect` prints the inventory; `snapshot` writes a deterministic snapshot file; `check` compares the application against it. Exit codes are contractual: 0 clean, 1 drift, 2 could not run.
  - Drift is classified, not merely detected: _widening_ (the agent gained reach or a control weakened), _narrowing_, _neutral_, with `--fail-on widening`. A `sideEffect` change counts as widening in both directions — declaring less than before stops policies keyed on the old value from matching — and `idempotent: false → true` is widening, being the flag that permits retrying a write.
  - The entry module is imported in a child process with `ORPC_AGENT_INSPECT=1` and a timeout; a function export is refused rather than called. TypeScript loads natively on Node ≥ 22.18, otherwise through the project's own `tsx`/`jiti` — neither is a dependency.
  - `--format github` emits annotations, `--format md` a pull-request table.
  - The tool documents what it cannot see: it does not evaluate policies, so it reports declarations, not reachability.

  Core: `defaultToolName` is now a public export. It had three copies (registry, MCP adapter, AI SDK adapter); both adapters now import it, so protocol naming has one implementation and tooling reports the adapters' actual mapping.

## 0.2.0

### Minor Changes

- 53b20a9: Startup footgun warnings (ADR-014): `createAgentRuntime` warns when approval-gated capabilities run on the default in-memory coordinator without an inline handler, and when write-capable capabilities are exposed to model surfaces with no audit sink; `warnings: false` silences. Schema-conversion cache is invalidated on `registerSchemaConverter`, and `describe` clones cached conversions into descriptors so callers cannot poison the cache.
