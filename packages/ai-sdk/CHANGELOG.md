# @orpc-agent/ai-sdk

## 3.0.0

### Patch Changes

- Updated dependencies [481c0ef]
  - @orpc-agent/core@3.0.0

## 2.0.2

### Patch Changes

- d45f8db: Docs links in package metadata and READMEs now point at the documentation site, orpc-agent.dev, instead of GitHub blob URLs — `homepage` is the package's own docs page. `repository` and `bugs` still point at GitHub.
- Updated dependencies [d45f8db]
  - @orpc-agent/core@2.0.2

## 2.0.0

### Minor Changes

- 2f8f73f: `toAISDKTools` takes a `scope`, forwarded verbatim to `runtime.describe`.

  `filter` is unchanged and still applies after, so a consumer can scope cheaply and then shape precisely: **`scope` decides what gets discovered; `filter` decides what survives discovery.** Neither is authorization (SI-2).

### Patch Changes

- Updated dependencies [2f8f73f]
- Updated dependencies [2f8f73f]
- Updated dependencies [2f8f73f]
  - @orpc-agent/core@2.0.0

## 1.1.0

### Minor Changes

- b489ee1: Support Vercel AI SDK v6: the `ai` peer range widens from `^5.0.0` to `^5.0.0 || ^6.0.0`.

  One code path, no compat shim — the APIs the adapter uses are unchanged across the majors. `tool()` keeps its overloads, `jsonSchema()` only widened its accepted input, and a `Record<string, Tool>` still satisfies `ToolSet`. `jsonSchema()` without an explicit `validate` performs no validation in either major, so the runtime remains the single validation authority on both.

  CI now runs the package's suite and typecheck against both majors on every PR (`ai-sdk (ai v5)` and `ai-sdk (ai v6)`); the v6 leg resolves through an aliased `ai-v6` devDependency, so it is lockfile-pinned rather than a floating install, and the suite asserts which major it actually loaded.

  `ai@6` ships its own tool-approval gate (`needsApproval`). The adapter does not set it: approval authority stays with the runtime, which binds it to a canonical input hash, records it with the coordinator and audits it. Approvals continue to reach the model as the `approval-required` envelope.

## 1.0.0

### Patch Changes

- Updated dependencies [7751b9a]
  - @orpc-agent/core@1.0.0

## 0.3.0

### Patch Changes

- e3469e7: New package `@orpc-agent/cli` — capability inventory and CI drift gate (ADR-015).

  The binary `orpc-agent` answers two questions about a repository: what an agent can reach from it, and whether that changed in a pull request.

  - `orpc-agent inspect` prints the inventory; `snapshot` writes a deterministic snapshot file; `check` compares the application against it. Exit codes are contractual: 0 clean, 1 drift, 2 could not run.
  - Drift is classified, not merely detected: _widening_ (the agent gained reach or a control weakened), _narrowing_, _neutral_, with `--fail-on widening`. A `sideEffect` change counts as widening in both directions — declaring less than before stops policies keyed on the old value from matching — and `idempotent: false → true` is widening, being the flag that permits retrying a write.
  - The entry module is imported in a child process with `ORPC_AGENT_INSPECT=1` and a timeout; a function export is refused rather than called. TypeScript loads natively on Node ≥ 22.18, otherwise through the project's own `tsx`/`jiti` — neither is a dependency.
  - `--format github` emits annotations, `--format md` a pull-request table.
  - The tool documents what it cannot see: it does not evaluate policies, so it reports declarations, not reachability.

  Core: `defaultToolName` is now a public export. It had three copies (registry, MCP adapter, AI SDK adapter); both adapters now import it, so protocol naming has one implementation and tooling reports the adapters' actual mapping.

- Updated dependencies [e3469e7]
  - @orpc-agent/core@0.3.0

## 0.2.0

### Minor Changes

- 40313df: Version alignment for the 0.2 "Durability seams" release (linked lockstep across `@orpc-agent/*`); no functional changes.

### Patch Changes

- Updated dependencies [53b20a9]
  - @orpc-agent/core@0.2.0
