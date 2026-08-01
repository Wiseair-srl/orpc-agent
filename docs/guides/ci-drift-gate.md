# Guide: a drift gate in CI

> Ten minutes of setup so that widening what an agent can reach shows up in code review. Command and flag reference: [reference/cli](../reference/cli.md).

Exposure is a one-line decision. `expose: { mcp: false }` → `true` on a destructive capability is a one-character diff that hands an external client the ability to delete things — and it looks like nothing in a 400-line pull request.

The gate makes that diff loud. You commit a snapshot of what an agent can reach; CI fails when the real surface no longer matches, and says what each change *means*.

## 1. Export a governance

The tool reads a value, never a function it calls, so the thing it points at has to be safe at module scope:

```ts
// src/app.ts
export const capabilities = createCapabilityRegistry({ /* … */ });

export const governance = defineGovernance({
  registry: capabilities,
  policies: [orgIsolation, gateModelWrites],
});

// runtimes are built from it, wherever and however you build them
export function createRuntimeFor(session: Session) {
  return createAgentRuntime({ governance, approvals: { coordinator }, audit });
}
```

A bare `CapabilityRegistry` works too — but it names no policies, so the snapshot records `runtime policies not observed` and **cannot detect a runtime policy being deleted**. Since that deletion is the most consequential edit this gate exists to catch, export the governance.

## 2. Run `init`

```bash
pnpm add -D @orpc-agent/cli
pnpm orpc-agent init
```

It finds the conventional entry modules, loads the one you pick through the same child-process loader `check` will use — so what it reports is what CI will see — and shows you the findings before writing anything:

```
Found in src/app.ts

  capabilities        24
  exposed             19
  approval-gated       2  declared in meta.approval
  runtime policies    org-isolation, gate-model-writes

Write this to package.json? (Y/n)
```

On confirmation it writes `orpcAgent` into `package.json`, the baseline snapshot, and a `check:capabilities` script:

```json
{ "orpcAgent": { "entry": "src/app.ts", "export": "governance" } }
```

Commit `capabilities.snapshot.json`. It is deterministic — no timestamps, no absolute paths, JSON Schema canonicalized before hashing — so a clean run is byte-identical and every diff is a real change.

No TTY? Write those four lines by hand and run `pnpm orpc-agent snapshot`.

## 3. Wire it into CI

```yaml
- run: pnpm build
- run: pnpm orpc-agent check --format github
```

`--format github` emits annotations, with widening as `::error` and the rest quieter. `--format md` produces a table suited to a pull-request comment.

**Treat exit code 2 as a failure.** `0` is clean, `1` is drift, `2` means the tool never loaded your app. A gate that cannot tell "nothing changed" from "nothing ran" rots without anyone noticing — most CI runners get this right by default, but check if you wrap the command.

## Reading a failure

```
Capability drift — 3 changes, 2 widening

WIDENING — the agent gained reach, or a control weakened
  orders.refund   expose      now exposed on mcp
  (runtime)       policies    runtime policy removed: gate-model-writes — it applied to
                              every invocation; any approval, denial or hiding it added is gone

NEUTRAL
  orders.search   description changed
```

Three classifications, and the two counter-intuitive ones are deliberate:

- **Widening** — a new surface, a capability that arrives already exposed, approval no longer required, risk lowered, a policy removed, redaction removed, retries added to a write. Also **`sideEffect` changed in either direction**: declaring `read` where you declared `write` silently stops every policy keyed on the old value from matching, which weakens governance exactly like a new exposure. And **`idempotent: false → true`**, because that flag is what permits retrying a write (SI-11).
- **Narrowing** — a capability or surface removed, approval added, risk raised, a policy or redaction added.
- **Neutral** — description, input schema, tool name, tags, timeout, approval type, policy reorder. Not "ignorable": a changed description is a changed prompt, and a renamed tool breaks host configs pinned to the old name.

When the change is intended, re-run `pnpm orpc-agent snapshot` and commit the new baseline **in the same pull request**. The point is that a human said yes in a diff, not that the surface never moves.

## Tuning the strictness

Any diff fails by default. If that is too noisy while a codebase is young:

```bash
orpc-agent check --fail-on widening
```

Only widening is then fatal; narrowing and neutral changes are reported and pass. It is a reasonable starting point, and a bad end state — neutral changes include prompt-visible descriptions and wire-name renames, both of which break things quietly.

## What this does not tell you

Stated up front, because a governance tool that overstates its coverage is worse than none:

- **It never evaluates a policy.** Deciding anything needs a real actor, surface, input, and context, and may do I/O. The tool reports that a policy *exists* — its name and phases — never which capabilities it gates. A capability that a policy hides from every actor still appears in the inventory, and the header says `0 approval-gated (declared)` rather than `0 approval-gated` for exactly this reason.
- **It compares against a baseline.** Code that was wrong from its first commit has nothing to drift from.
- **Adapter-level `toolNaming` is invisible.** Wire names come from metadata; an adapter constructed with its own naming function overrides them.

## Upgrading an old snapshot

Snapshots are written at version 2, which added the `runtime` key. Version 1 files still read as "runtime policies never observed" — accurate, and nothing breaks on upgrade. But **until you re-run `orpc-agent snapshot`, a runtime policy removal stays invisible**, so `check` prints a notice on stderr that survives `--fail-on widening`:

```
orpc-agent: capabilities.snapshot.json predates runtime-policy recording. 2 runtime
policies are configured and NOT covered by this gate yet. Run: orpc-agent snapshot
```

Do what it says, once.

## Related

- [Reference: CLI](../reference/cli.md) — every command, flag, and snapshot field
- [Guide: capability exposure](capability-exposure.md) — the decisions this gate watches
- [Guide: adding policies](adding-policies.md) — why runtime policies belong in a `defineGovernance` export
