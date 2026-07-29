# CLI

> **Status:** implemented in v0.3 · package `@orpc-agent/cli` · binary `orpc-agent` · [ADR-015](../architecture/decisions.md#adr-015-a-developer-cli-with-capability-inventory-as-its-first-command)

A developer tool, not an adapter: it exposes nothing to an agent and hardcodes no surface value. It answers *what can an agent reach from this repository*, and *did that change in this pull request*.

```bash
pnpm add -D @orpc-agent/cli
```

## Point `--entry` at the governance

A [`defineGovernance`](core.md#definegovernance) value is the form to read: it names the registry **and** the runtime-level policies, and it is safe at module scope, so it does not matter that the runtimes serving traffic are built inside a factory the CLI will not call.

```ts
export const governance = defineGovernance({
  registry: capabilities,
  policies: [orgIsolation, mcpReadOnly],
});

// every runtime this app builds starts from it
const dashboard = createAgentRuntime({ governance, approvals: { coordinator } });
```

```json
{ "orpcAgent": { "entry": "src/app.ts", "export": "governance" } }
```

An [`AgentRuntime`](runtime.md) works too — it carries the governance it was built from. A bare `CapabilityRegistry` also works and names no policies at all.

A module exporting all three is not ambiguous: whichever carries the most governance wins, governance first. Exports resolving to genuinely different registries still require `--export`. Reading a bare registry while the same module exports a governance over it prints a warning naming the export you probably wanted.

## What it does not see

Stated first, because a governance tool that overstates its coverage is worse than none:

- **It does not evaluate policies, and never will.** `evaluate` needs a real actor, surface, input and context, and may do I/O. The tool reports that a policy *exists* — its name and phases — and never which capabilities it gates or under what conditions. A capability a policy would hide from every actor still appears here, and the `APPROVAL` column shows only what `meta.approval` declares.

  This is why the header reads `1 approval-gated (declared)` rather than `1 approval-gated`: a `0` there is a statement about metadata, never on its own a statement that nothing is gated. Read it with the runtime policies block. `check` diffs *declarations*, not reachability.
- **Runtime policies are in scope only when the entry names them.** `--entry` resolving a bare registry reports `runtime policies not observed` — *unknown*, not *none*. A snapshot taken that way cannot detect a runtime policy being deleted.
- **Adapter-level `toolNaming` is invisible.** `toolNames` comes from metadata (`meta.adapters.<surface>.toolName ?? defaultToolName(id)`); an adapter constructed with its own naming function overrides it.
- **Composite policies:** runtime-level composites are **flattened** to their members, matching what the pipeline evaluates and audit records — otherwise removing a member from a composite would leave the composite's name unchanged and the removal invisible. Capability-scoped `meta.policies` still appear under the composite's name; the asymmetry is deliberate, since changing it would rewrite values in every committed snapshot for no security gain.
- **It compares against a baseline.** Code that is wrong from the first commit has nothing to drift from — that is a rules engine, a different mechanism, not in this version.

## Commands

| Command | Purpose |
|---|---|
| `orpc-agent init` | interactive setup: entry, export, baseline snapshot, CI script |
| `orpc-agent inspect` | print the inventory; `--json` emits the snapshot |
| `orpc-agent snapshot` | write the snapshot file — also how you update it |
| `orpc-agent check` | compare the application against the snapshot file |

### `init`

Discovers the conventional entry modules that exist, loads the chosen one through the same child-process loader every other command uses — so what it reports is what `check` will see — and shows the findings before writing anything:

```
Found in src/app.ts

  capabilities        2
  exposed             2
  approval-gated      0  declared in meta.approval
  runtime policies    gate-model-writes

Write this to package.json? (Y/n)
```

When the chosen export is a bare registry while the same module exports a governance over it, `init` says so and offers the governance instead, since recording less is the expensive default. On confirmation it writes `orpcAgent` into `package.json` (merging, so a hand-set `snapshot` path survives a re-run), optionally the baseline snapshot, and a `check:capabilities` script if none exists.

It **refuses rather than degrades** without a terminal: a wizard with no keyboard is not a wizard, and writing a guessed config would be worse than printing what to set by hand.

**Exit codes are part of the contract:** `0` clean · `1` drift · `2` could not run. CI must distinguish "the inventory changed" from "the tool never loaded the app"; the second one passing silently is how a gate rots.

### Options

| Option | Meaning |
|---|---|
| `--entry <path>` | the module exporting a governance, runtime, or registry |
| `--export <name>` | which export to read (required when several match) |
| `--snapshot <path>` | snapshot file (default `capabilities.snapshot.json`) |
| `-o, --out <path>` | snapshot output path; `-` for stdout |
| `--fail-on <any\|widening>` | which drift fails `check` (default `any`) |
| `--format <human\|md\|github>` | `check` report format |
| `--json` | `inspect`: emit the snapshot instead of a table |
| `--plain` | never use the interactive renderer |
| `--no-descriptions` | omit descriptions from the snapshot |
| `--import <module>` | preload a module in the loader process |
| `--timeout <ms>` | loader timeout (default 30000) |
| `--cwd <path>` | run as if from this directory |

Defaults may live in `package.json`, which reduces the CI step to `orpc-agent check`:

```json
{ "orpcAgent": { "entry": "src/app.ts", "export": "governance" } }
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

- `runtime` is present **only when the entry named the runtime-level policies**, and absence is a different fact from emptiness. Absent means they were never observed (`--entry` resolved a bare registry, or a runtime from a core too old to carry its governance) — *unknown*. Present with `"policies": []` means observed, and genuinely none. The diff acts on the difference, so the key is never defaulted to empty.

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

## Terminal output

`inspect` renders a richer view when attached to a terminal — colour-coded side effect and risk, and the runtime-policy state as a panel rather than a trailing line, because that is the fact most easily skimmed past. It falls back to the plain renderer, byte for byte, when output is piped or redirected, `CI` or `NO_COLOR` is set, `--plain` is passed, or the optional UI dependencies are absent.

`check` is **always** plain. Its output is a report pasted into pull requests and read out of CI logs; stable text is the feature. No module `check` reaches imports a rendering framework, even optionally.

The interactive layer is [Ink](https://github.com/vadimdemedes/ink), in `optionalDependencies` and loaded through a dynamic `import()`. Installing with `--no-optional` keeps the gate to this package plus core; everything except `init` still works ([ADR-016](../architecture/decisions.md#adr-016-runtime-policies-are-part-of-the-governance-contract) §10, amending [ADR-015](../architecture/decisions.md#adr-015-a-developer-cli-with-capability-inventory-as-its-first-command) §7).

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
