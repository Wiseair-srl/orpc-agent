---
"@orpc-agent/core": minor
"@orpc-agent/cli": minor
---

Runtime-level policies become part of the governance contract (ADR-016).

`AgentMeta.approval` documents itself as a *static* gate and directs conditional approval into policies — correctly, since a static gate fires on every surface. Applications followed that and registered a runtime-level policy returning `requireApproval()` for model surfaces only. The inventory then reported them as having **zero approval gating**, and — worse — deleting that policy left every snapshot field byte-identical, so `check` passed green while destructive capabilities became callable by a model loop with no approval.

**Core**

- **`defineGovernance({ registry, policies })`** declares an application's governed surface as one value, separate from the per-instance wiring (`approvals`, `audit`, `tracing`, `now`) `createAgentRuntime` also takes. Two guarantees follow, both structural:
  - Every runtime built from it evaluates exactly the published list — there is no `policies` key to append to. An application can build a coordinator-backed runtime and an inline-confirm one over the same governance and they cannot disagree about what is governed.
  - Tooling reads it without a runtime instance, which matters because runtimes are usually built inside a factory and the CLI reads values rather than calling functions.

  `AgentRuntimeOptions` becomes a union: `governance`, or `registry`/`policies` inline as before, normalized into the same shape and reachable as `runtime.governance`.
- `runtime.policies` (aka `governance.manifest`) exposes the runtime-level policies as `{ name, phases }`, in evaluation order, composites flattened, frozen. Never `evaluate`: a decision is only meaningful inside the pipeline, and handing out the closure would invite calls that look authoritative and are not. The names are already in every audit event.
- New startup warning for the same blind spot: policies configured, `destructive`/`external` capabilities on model surfaces, and the default in-memory coordinator — a policy-driven approval would suspend into storage that does not survive restarts. Narrowed to irreversible side effects on purpose, so ordinary rate-limit policies do not cost a warning.

**CLI**

- **Snapshot version 2** adds an optional `runtime` key, where absent and empty are different facts: absent means no runtime was observed (*unknown*), present with `policies: []` means observed and none.
- **Removing a runtime policy is `widening`.** So is a policy dropping a phase, and so is the snapshot ceasing to observe runtime policies at all.
- **Version 1 snapshots are still read**, as "never observed". No committed snapshot breaks and no `--fail-on widening` gate turns red on upgrade. The transition to observed is neutral — the application did not change — but `check` prints a notice on stderr that survives widening-only mode, because until the snapshot is rewritten the removal check is inert.
- The header is qualified: `0 approval-gated (declared)`, plus whether runtime policies were in scope. A README caveat does not travel with terminal output pasted into a compliance review.
- `--entry` accepts a governance, a runtime, or a bare registry. A module exporting several of them is no longer refused as ambiguous — whichever carries the most governance wins. Reading a bare registry while a governed export exists prints the export you probably wanted.
- **`orpc-agent init`** — interactive setup that discovers the entry, reports what a snapshot would record, and writes the config, the baseline and the CI script on confirmation. Refuses without a TTY rather than writing a guessed config.
- **`inspect` renders a richer view in a terminal**, with the runtime-policy state as a panel. Falls back to the plain renderer byte for byte when piped, in CI, under `NO_COLOR`, with `--plain`, or when the optional UI dependencies are absent. `check` is always plain — no module it reaches imports a rendering framework.
- **`@orpc-agent/core` is now a peer dependency.** The requirement is not "same version" but *same module instance*: `registerSchemaConverter` writes to module-level state in core, so a duplicated copy makes an application's converter invisible to the CLI and turns every custom-vendor `inputSchemaHash` into `"unconvertible"` — phantom drift no source change caused, reproducible with two byte-identical copies.

**Migration.** Nothing breaks. To get the new coverage: declare your runtime-level policies with `defineGovernance`, export that value, point `--entry`/`--export` at it, and re-run `orpc-agent snapshot`. Both examples in this repository show the shape — neither had to change how it builds runtimes, because it is the governance that moves to module scope, not the runtime.
