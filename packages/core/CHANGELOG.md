# @orpc-agent/core

## 1.0.0

### Minor Changes

- 7751b9a: Runtime-level policies become part of the governance contract (ADR-016).

  `AgentMeta.approval` documents itself as a _static_ gate and directs conditional approval into policies — correctly, since a static gate fires on every surface. Applications followed that and registered a runtime-level policy returning `requireApproval()` for model surfaces only. The inventory then reported them as having **zero approval gating**, and — worse — deleting that policy left every snapshot field byte-identical, so `check` passed green while destructive capabilities became callable by a model loop with no approval.

  **Core**

  - **`defineGovernance({ registry, policies })`** declares an application's governed surface as one value, separate from the per-instance wiring (`approvals`, `audit`, `tracing`, `now`) `createAgentRuntime` also takes. Two guarantees follow, both structural:

    - Every runtime built from it evaluates exactly the published list — there is no `policies` key to append to. An application can build a coordinator-backed runtime and an inline-confirm one over the same governance and they cannot disagree about what is governed.
    - Tooling reads it without a runtime instance, which matters because runtimes are usually built inside a factory and the CLI reads values rather than calling functions.

    **BREAKING — `governance` is the only form `createAgentRuntime` accepts.** Keeping `registry`/`policies` as a compatible second arm was considered and rejected: it is exactly the arm where a runtime evaluates a list no exported value names, so it would have preserved the hole this release closes. Migration is one mechanical edit per call site:

    ```ts
    -createAgentRuntime({ registry, policies, ...wiring }) +
      createAgentRuntime({
        governance: defineGovernance({ registry, policies }),
        ...wiring,
      });
    ```

    `runtime.governance.manifest` exposes the policy identity as `{ name, phases }`, frozen. Never `evaluate`: a decision is only meaningful inside the pipeline. `runtime.registry` remains as a read accessor for adapters.

  - **BREAKING — `warnings` is removed, with no replacement.** Every startup warning already fires only where a decision was left implicit, and is answered by making it: name `approvals.coordinator` (`createInMemoryApprovalCoordinator()` is a legitimate answer), or name an audit sink (`audit: () => {}` states deliberately that nothing is recorded). A mute switch was a second way to say the same thing and a worse one — global, outliving the reason it was added, and hiding the decision from review.
  - New startup warning for the policy-shaped blind spot: policies configured, write-capable capabilities on model surfaces, and no coordinator named — a policy returning `requireApproval` would suspend into storage that does not survive a restart. Sized for coverage rather than quiet, which is only safe because there is no mute switch left for a noisy warning to trip.

  **CLI**

  - **Snapshot version 2** adds an optional `runtime` key, where absent and empty are different facts: absent means no runtime was observed (_unknown_), present with `policies: []` means observed and none.
  - **Removing a runtime policy is `widening`.** So is a policy dropping a phase, and so is the snapshot ceasing to observe runtime policies at all.
  - **Version 1 snapshots are still read**, as "never observed". No committed snapshot breaks and no `--fail-on widening` gate turns red on upgrade. The transition to observed is neutral — the application did not change — but `check` prints a notice on stderr that survives widening-only mode, because until the snapshot is rewritten the removal check is inert.
  - The header is qualified: `0 approval-gated (declared)`, plus whether runtime policies were in scope. A README caveat does not travel with terminal output pasted into a compliance review.
  - `--entry` accepts a governance, a runtime, or a bare registry. A module exporting several of them is no longer refused as ambiguous — whichever carries the most governance wins. Reading a bare registry while a governed export exists prints the export you probably wanted.
  - **`orpc-agent init`** — interactive setup that discovers the entry, reports what a snapshot would record, and writes the config, the baseline and the CI script on confirmation. Refuses without a TTY rather than writing a guessed config.
  - **`inspect` renders a richer view in a terminal**, with the runtime-policy state as a panel. Falls back to the plain renderer byte for byte when piped, in CI, under `NO_COLOR`, with `--plain`, or when the optional UI dependencies are absent. `check` is always plain — no module it reaches imports a rendering framework.
  - **`@orpc-agent/core` is now a peer dependency.** The requirement is not "same version" but _same module instance_: `registerSchemaConverter` writes to module-level state in core, so a duplicated copy makes an application's converter invisible to the CLI and turns every custom-vendor `inputSchemaHash` into `"unconvertible"` — phantom drift no source change caused, reproducible with two byte-identical copies.

  **Migration.** Nothing breaks. To get the new coverage: declare your runtime-level policies with `defineGovernance`, export that value, point `--entry`/`--export` at it, and re-run `orpc-agent snapshot`. Both examples in this repository show the shape — neither had to change how it builds runtimes, because it is the governance that moves to module scope, not the runtime.

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
