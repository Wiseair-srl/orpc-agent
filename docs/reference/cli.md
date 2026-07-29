# CLI

> **Status:** implemented in v0.3 · package `@orpc-agent/cli` · binary `orpc-agent` · [ADR-015](../architecture/decisions.md#adr-015-a-developer-cli-with-capability-inventory-as-its-first-command)

A developer tool, not an adapter: it exposes nothing to an agent and hardcodes no surface value. It answers *what can an agent reach from this repository*, and *did that change in this pull request*.

```bash
pnpm add -D @orpc-agent/cli
```

## Point `--entry` at the runtime

Both a capability registry and an [`AgentRuntime`](runtime.md) are accepted, but only the runtime puts **runtime-level policies** in scope — and a conditional approval gate usually lives there rather than in `meta.approval`, which fires on every surface.

A module exporting both is not ambiguous: the runtime wins, since it describes the same capabilities plus the policies. Exports resolving to genuinely different registries still require `--export`. Reading a registry while the same module exports a runtime over it prints a warning naming the export you probably wanted.

When the serving runtime is built inside a factory — for per-request context, an injected clock, a seeded audit sink — the CLI will not call it. Export one at module scope for governance, built from the same policy constant:

```ts
const GOVERNANCE = { registry: capabilities, policies: [orgIsolation, mcpReadOnly] };

/** Read by `orpc-agent`; makeApp() spreads the same constant. */
export const governanceRuntime = createAgentRuntime<AppContext>({
  ...GOVERNANCE,
  warnings: false,
});
```

Construction is pure and does no I/O, so this costs nothing at import time, and spreading one constant means it cannot report a policy list the serving runtimes do not use. Both examples in this repository use exactly this shape.

## What it does not see

Stated first, because a governance tool that overstates its coverage is worse than none:

- **It does not evaluate policies, and never will.** `evaluate` needs a real actor, surface, input and context, and may do I/O. The tool reports that a policy *exists* — its name and phases — and never which capabilities it gates or under what conditions. A capability a policy would hide from every actor still appears here, and the `APPROVAL` column shows only what `meta.approval` declares.

  This is why the header reads `1 approval-gated (declared)` rather than `1 approval-gated`: a `0` there is a statement about metadata, never on its own a statement that nothing is gated. Read it with the runtime policies block. `check` diffs *declarations*, not reachability.
- **Runtime policies are in scope only when a runtime is.** `--entry` resolving a bare registry reports `runtime policies not observed` — *unknown*, not *none*. A snapshot taken that way cannot detect a runtime policy being deleted.
- **Adapter-level `toolNaming` is invisible.** `toolNames` comes from metadata (`meta.adapters.<surface>.toolName ?? defaultToolName(id)`); an adapter constructed with its own naming function overrides it.
- **Composite policies:** runtime-level composites are **flattened** to their members, matching what the pipeline evaluates and audit records — otherwise removing a member from a composite would leave the composite's name unchanged and the removal invisible. Capability-scoped `meta.policies` still appear under the composite's name; the asymmetry is deliberate, since changing it would rewrite values in every committed snapshot for no security gain.
- **It compares against a baseline.** Code that is wrong from the first commit has nothing to drift from — that is a rules engine, a different mechanism, not in this version.

## Commands

| Command | Purpose |
|---|---|
| `orpc-agent inspect` | print the inventory; `--json` emits the snapshot |
| `orpc-agent snapshot` | write the snapshot file — also how you update it |
| `orpc-agent check` | compare the application against the snapshot file |

**Exit codes are part of the contract:** `0` clean · `1` drift · `2` could not run. CI must distinguish "the inventory changed" from "the tool never loaded the app"; the second one passing silently is how a gate rots.

### Options

| Option | Meaning |
|---|---|
| `--entry <path>` | the module exporting a capability registry |
| `--export <name>` | which export to read (required when several match) |
| `--snapshot <path>` | snapshot file (default `capabilities.snapshot.json`) |
| `-o, --out <path>` | snapshot output path; `-` for stdout |
| `--fail-on <any\|widening>` | which drift fails `check` (default `any`) |
| `--format <human\|md\|github>` | `check` report format |
| `--json` | `inspect`: emit the snapshot instead of a table |
| `--no-descriptions` | omit descriptions from the snapshot |
| `--import <module>` | preload a module in the loader process |
| `--timeout <ms>` | loader timeout (default 30000) |
| `--cwd <path>` | run as if from this directory |

Defaults may live in `package.json`, which reduces the CI step to `orpc-agent check`:

```json
{ "orpcAgent": { "entry": "src/app.ts", "export": "governanceRuntime" } }
```

## The snapshot

Deterministic by construction — no timestamps, no generator version, no absolute paths, JSON Schema canonicalized before hashing. A clean run is byte-identical, so every diff is a real change.

```json
{
  "version": 2,
  "capabilities": [
    {
      "id": "orders.refund",
      "description": "Refund a settled order.",
      "sideEffect": "write",
      "risk": "high",
      "expose": ["aiSdk", "direct"],
      "toolNames": { "aiSdk": "orders_refund" },
      "approval": { "required": true, "type": "refund" },
      "idempotent": false,
      "tags": ["orders"],
      "policies": ["refund-limit"],
      "redact": { "output": true, "approvalInput": false },
      "inputSchemaHash": "sha256:…"
    }
  ],
  "excluded": ["internal.debug"],
  "unexposed": ["orders.void"],
  "runtime": {
    "policies": [{ "name": "gate-model-writes", "phases": ["invocation"] }]
  }
}
```

Field notes:

- `runtime` is present **only when a runtime was in scope**, and absence is a different fact from emptiness. Absent means no runtime was observed (`--entry` resolved a bare registry, or the runtime came from a core too old to report) — *unknown*. Present with `"policies": []` means observed, and genuinely none. The diff acts on the difference, so the key is never defaulted to empty.

- `expose` lists only surfaces set to exactly `true` — an explicit `false` and an absent surface are the same fact (SI-1) and serialize identically.
- `policies` keeps **declaration order**, not sorted: evaluation order decides which policy is recorded as the denier and how the batch timeout budget is spent. `tags` are sorted, being a set.
- Functions reduce to presence flags: `redact.output`, `redact.approvalInput`, `retry.retryOn`.
- `inputSchemaHash` is `null` for no input, or `"unconvertible"` when no converter handles the schema — a real state whose transitions are real drift.
- `excluded` (procedures without `meta.agent`) and `unexposed` (staged capabilities) are part of the contract: a procedure that stops being excluded is exactly the regression worth catching. `unexposed` is not diffed — it is derived from the expose maps, so its changes are already reported as exposure changes.

## Drift classification

`check` fails on any diff by default and labels what each one means.

**Widening — the agent gained reach, or a control weakened.** A new surface; a new capability that arrives already exposed; approval no longer required; risk lowered; a policy removed; redaction removed; a procedure that gained `meta.agent`; retries added to a write.

Three are counter-intuitive and deliberate:

| Change | Why it is widening |
|---|---|
| `sideEffect` changed **in either direction** | declaring less than before (`write` → `read`) silently stops every policy keyed on `sideEffect` from matching — that weakens governance exactly like a new exposure |
| `idempotent: false` → `true` | it is the flag that lets the runtime retry a write ([SI-11](../security/idempotency-and-retries.md)) |
| runtime policies **stop being observed** | the snapshot loses the ability to detect a removal. Reverting to a weaker check is a weakened control, not a neutral one |

### Runtime policies

Removing an entry from `createAgentRuntime({ policies: [...] })` is **widening**, and it is why the snapshot records the runtime at all. It is the one edit that can strip a conditional approval gate from every capability at once while leaving every per-capability field byte-identical:

```
WIDENING — the agent gained reach, or a control weakened
  (runtime)  runtime.policies  runtime policy removed: mcp-read-only — it applied to
                               every invocation; any approval, denial or hiding it added is gone
```

A policy that keeps its name but **drops a phase** is widening too — it stops running there. Gaining one is narrowing; reordering is neutral, mirroring the capability-scoped rule, since order decides the recorded denier and the timeout budget.

### Snapshot versions

Snapshots are written at **version 2**, which added the `runtime` key. Version 1 files are still read: they predate the key and therefore mean "runtime policies were never observed", which is accurate. Upgrading breaks no committed snapshot and turns no `--fail-on widening` gate red.

The cost of that safety: **until you re-run `orpc-agent snapshot`, a runtime policy removal is still invisible**, because the baseline has nothing to compare against. The transition is classed neutral — the application did not change, the tool started looking — so `check` prints a notice on stderr that survives `--fail-on widening`:

```
orpc-agent: capabilities.snapshot.json predates runtime-policy recording. 2 runtime
policies are configured and NOT covered by this gate yet. Run: orpc-agent snapshot
```

**Narrowing** — capability or surface removed, approval added, risk raised, policy added, redaction added.

**Neutral** — description, input schema, tool name, tags, timeout, approval type, policy reorder. Neutral is not "ignorable": a changed description is a changed prompt, and a renamed tool breaks host configs pinned to the old name.

## How it loads your application

The entry module is imported **in a child process**. Importing an application runs its top-level code — pools, servers, migrations — and isolation is what lets the CLI time out and hard-exit without inheriting any of it. The child gets `ORPC_AGENT_INSPECT=1`:

```ts
if (process.env.ORPC_AGENT_INSPECT !== "1") await connect();
```

TypeScript entries load natively on Node ≥ 22.18. On older Node the CLI uses `tsx` or `jiti` **only if the project already has one** — neither is a dependency — and otherwise says so rather than guessing. `--import <module>` overrides; a compiled JavaScript entry needs nothing.

Exports are matched by shape: a `CapabilityRegistry`, or an `AgentRuntime` (its `registry` is read). Several matches ask for `--export`. A **function** export is refused rather than called — calling it could connect, migrate, or charge a card. The inventory is read from a value, never produced by invoking application code.

## In CI

```yaml
- run: pnpm build
- run: npx orpc-agent check --format github
```

`--format github` emits annotations with widening as `::error` and the rest quieter; `--format md` produces a pull-request comment table.

This repository dogfoods it: both examples carry committed snapshots and `pnpm check:capabilities` runs in CI, which makes exposure semantics a regression test of the framework itself.

## Programmatic API

```ts
import {
  buildSnapshot,      // (registry, { descriptions? }) => CapabilitySnapshot
  diffSnapshots,      // (before, after) => Change[]
  loadSnapshot,       // (options) => Promise<{ snapshot, usedImport }>
  renderChanges,      // and renderInventory / renderMarkdown / renderGithub
  snapshotJson,
} from "@orpc-agent/cli";
```

Use these to build a gate with different rules — per-team ownership, a stricter allowlist, a custom report — without re-deriving the snapshot format.
