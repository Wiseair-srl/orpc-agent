# @orpc-agent/cli

Capability inventory and CI drift gate for [oRPC Agent](https://orpc-agent.dev) applications.

Answers two questions about a repository: *what can an agent reach from here*, and *did that change in this pull request*.

```bash
pnpm add -D @orpc-agent/cli
```

```bash
npx orpc-agent inspect --entry src/app.ts
```

```
10 capabilities · 10 exposed · 1 approval-gated (declared) · 1 runtime policy

CAPABILITY                     SIDE EFFECT  RISK    EXPOSE                    APPROVAL  POLICIES
cases.escalate                 write        medium  aiSdk, direct, test       —         —
customers.get                  read         high    aiSdk, direct, mcp, test  —         —
messages.send                  external     high    aiSdk, direct, test       required  —
orders.refund                  write        high    aiSdk, direct, test       —         refund-limit

Runtime policies — evaluated on every invocation, before capability policies
  gate-model-writes  invocation
```

Point `--entry` at the module that exports your **`AgentRuntime`**, not just the registry. Both work, but only the runtime puts runtime-level policies in scope — and a conditional approval gate usually lives there. When one is not in scope the output says so, in place of the count:

```
10 capabilities · 10 exposed · 1 approval-gated (declared) · runtime policies not observed
```

## The gate

Commit the snapshot, then let CI fail on drift:

```bash
npx orpc-agent snapshot        # writes capabilities.snapshot.json
npx orpc-agent check           # exit 1 if the app no longer matches it
```

The snapshot is deterministic — no timestamps, no tool version, no absolute paths — so a clean run is byte-identical and any diff is a real change. When one shows up, `check` sorts it by what it means:

```
Capability drift — 3 changes, 2 widening

WIDENING — the agent gained reach, or a control weakened
  orders.refund  expose    now exposed on mcp
  billing.charge approval  approval no longer required

NEUTRAL — contract changes worth reading
  orders.refund  description  description changed — the model reads this
```

Two of those classifications are deliberately counter-intuitive:

- **`sideEffect` changes count as widening in both directions.** Declaring *less* than before (`write` → `read`) silently stops every policy keyed on `sideEffect` from matching. That weakens governance exactly like a new exposure does.
- **`idempotent: false → true` is widening.** It is the flag that lets the runtime retry a write.

Also widening: a lowered `risk`, a removed policy, removed redaction, a new capability that arrives already exposed, and a procedure that gains `meta.agent`.

**Removing a runtime-level policy is widening too**, and it is the reason the snapshot records the runtime at all. Deleting one entry from `createAgentRuntime({ policies: [...] })` can strip a conditional approval gate from every capability at once while leaving every per-capability field byte-identical — the largest possible change to what a model can reach, in one line, with nothing else to see:

```
WIDENING — the agent gained reach, or a control weakened
  (runtime)  runtime.policies  runtime policy removed: gate-model-writes — it applied to
                               every invocation; any approval, denial or hiding it added is gone
```

Losing sight of them is widening as well: if a snapshot recorded runtime policies and a later run does not observe any (because `--entry` was repointed at a bare registry), `check` fails rather than quietly reverting to a weaker check.

## Commands

| | |
|---|---|
| `orpc-agent inspect` | print the inventory (`--json` for the raw snapshot) |
| `orpc-agent snapshot` | write the snapshot file — also how you update it |
| `orpc-agent check` | compare the app against the snapshot file |

Exit codes are part of the contract: **0** clean · **1** drift · **2** could not run. CI has to tell "the inventory changed" apart from "the tool never loaded the app", because the second one passing silently is how a gate rots.

Useful flags: `--fail-on widening` (let narrowing changes through), `--format github` (annotations) or `--format md` (PR comment), `--export <name>` when a module exports several registries, `--no-descriptions`, `--timeout`, `--import <module>`.

Defaults can live in `package.json`, which makes the CI step just `orpc-agent check`:

```json
{ "orpcAgent": { "entry": "src/app.ts", "export": "capabilities" } }
```

## GitHub Actions

```yaml
- run: pnpm build
- run: npx orpc-agent check --format github
```

## How it loads your application

The entry module is imported **in a child process**, because importing an app runs its top-level code: it may open pools, start servers, or keep the event loop alive forever. Isolating it means the CLI can time out and hard-exit without inheriting any of that. The child gets `ORPC_AGENT_INSPECT=1` so an application can guard its own import-time work:

```ts
if (process.env.ORPC_AGENT_INSPECT !== "1") await connect();
```

TypeScript entries load natively on Node ≥ 22.18. On older Node the CLI uses `tsx` or `jiti` **if the project already has one** — neither is a dependency of this package — and otherwise says so instead of guessing. `--import <module>` overrides the choice; pointing `--entry` at compiled JavaScript needs nothing at all.

Exports are found by shape: a value from `createCapabilityRegistry`, or an `AgentRuntime`. A module that exports **both** a registry and the runtime built over it is not ambiguous — the runtime wins, since it describes the same capabilities plus the runtime-level policies. Exports resolving to genuinely different registries still ask for `--export`. A **function** export is refused rather than called — calling it could connect, migrate, or charge a card. The inventory is read from a value, never produced by invoking your code.

### Snapshot versions

Snapshots are written at **version 2**, which adds the `runtime` key. Version 1 files are still read: they predate the key, so they mean "runtime policies were never observed", which is exactly what they were. Upgrading therefore does not break a committed snapshot or a `--fail-on widening` gate — but until you re-run `orpc-agent snapshot`, the removal check has nothing to compare against. `check` prints a notice saying so.

## What this does not see

This is a static inventory. It reports what the registry, the metadata and the runtime configuration declare, and deliberately does not pretend to more:

- **It does not evaluate policies, and never will.** `evaluate` needs a real actor, surface, input and context, and may do I/O. So the tool reports that a policy *exists* — its name and phases — and never which capabilities it gates or under what conditions. A capability a policy would hide from everyone still appears here, and the `APPROVAL` column shows only what `meta.approval` declares.

  This is why the header count reads `1 approval-gated (declared)` rather than `1 approval-gated`, and why a `0` there is never on its own a statement that nothing is gated. Read it together with the runtime policies block. `check` is a diff of declarations, not a proof of reachability.
- **Runtime policies are only in scope when a runtime is.** `--entry` resolving a bare registry means they were never observed — reported as `runtime policies not observed`, which is *unknown*, not *none*. A snapshot taken that way cannot detect a runtime policy being deleted.
- **Adapter-level `toolNaming` is invisible.** `toolNames` is derived from metadata; an adapter configured with its own naming function overrides it.
- **Composite capability-scoped policies appear under the composite's name**, not their members'. Runtime-level composites are flattened, matching what audit events record.

Guarding against *new* code that is wrong from the start is a different job from guarding against change — a rules engine, not a snapshot. That is not in this version.

## Programmatic use

`buildSnapshot`, `diffSnapshots`, `loadSnapshot`, and the renderers are exported for building your own gate or report.

---

MIT · Independent community project, not affiliated with or endorsed by the oRPC maintainers.
