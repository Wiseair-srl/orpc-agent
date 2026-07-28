# CLI

> **Status:** implemented in v0.3 · package `@orpc-agent/cli` · binary `orpc-agent` · [ADR-015](../architecture/decisions.md#adr-015-a-developer-cli-with-capability-inventory-as-its-first-command)

A developer tool, not an adapter: it exposes nothing to an agent and hardcodes no surface value. It answers *what can an agent reach from this repository*, and *did that change in this pull request*.

```bash
pnpm add -D @orpc-agent/cli
```

## What it does not see

Stated first, because a governance tool that overstates its coverage is worse than none:

- **It does not evaluate policies.** Discovery-phase decisions need a real actor and context ([`runtime.describe`](runtime.md)), so a capability that a policy would hide from every actor still appears here, and approval that a policy adds conditionally shows as no approval. `check` diffs *declarations*, not reachability.
- **Adapter-level `toolNaming` is invisible.** `toolNames` comes from metadata (`meta.adapters.<surface>.toolName ?? defaultToolName(id)`); an adapter constructed with its own naming function overrides it.
- **Composite policies appear under the composite's name**, not their members'.
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
{ "orpcAgent": { "entry": "src/app.ts", "export": "capabilities" } }
```

## The snapshot

Deterministic by construction — no timestamps, no generator version, no absolute paths, JSON Schema canonicalized before hashing. A clean run is byte-identical, so every diff is a real change.

```json
{
  "version": 1,
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
  "unexposed": ["orders.void"]
}
```

Field notes:

- `expose` lists only surfaces set to exactly `true` — an explicit `false` and an absent surface are the same fact (SI-1) and serialize identically.
- `policies` keeps **declaration order**, not sorted: evaluation order decides which policy is recorded as the denier and how the batch timeout budget is spent. `tags` are sorted, being a set.
- Functions reduce to presence flags: `redact.output`, `redact.approvalInput`, `retry.retryOn`.
- `inputSchemaHash` is `null` for no input, or `"unconvertible"` when no converter handles the schema — a real state whose transitions are real drift.
- `excluded` (procedures without `meta.agent`) and `unexposed` (staged capabilities) are part of the contract: a procedure that stops being excluded is exactly the regression worth catching. `unexposed` is not diffed — it is derived from the expose maps, so its changes are already reported as exposure changes.

## Drift classification

`check` fails on any diff by default and labels what each one means.

**Widening — the agent gained reach, or a control weakened.** A new surface; a new capability that arrives already exposed; approval no longer required; risk lowered; a policy removed; redaction removed; a procedure that gained `meta.agent`; retries added to a write.

Two are counter-intuitive and deliberate:

| Change | Why it is widening |
|---|---|
| `sideEffect` changed **in either direction** | declaring less than before (`write` → `read`) silently stops every policy keyed on `sideEffect` from matching — that weakens governance exactly like a new exposure |
| `idempotent: false` → `true` | it is the flag that lets the runtime retry a write ([SI-11](../security/idempotency-and-retries.md)) |

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
