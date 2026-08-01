# Implementation plan — v0.2 "Durability seams"

> **Status:** **Executed** — N1–N7 implemented; kept as the record of how v0.2 was sequenced (like [milestones](milestones.md) for v0.1). One deviation from the letter of the plan: `toJsonSchema` turned out to be memoized since 0.1, so N5a narrowed to cache invalidation on `registerSchemaConverter` + descriptor isolation via cloning (recorded in [ADR-014](../architecture/decisions.md#adr-014-further-api-surface-decisions)). Scope was fixed by the 2026-07 gap review (driven by the first production consumer: an ~85-capability finance app on Mastra + Postgres).

## Release definition

- **Version:** 0.2.0, all `@orpc-agent/*` packages (changesets `linked` lifts every released package to the same version).
- **Contents:** one new package (`@orpc-agent/postgres`: reference approval coordinator + audit sink), three small core/mcp improvements, four docs/recipe additions, canon updates (Q8 resolution, ADR-013/014).
- **Explicitly out of scope for 0.2** (do not implement, even if adjacent): workflow-engine adapter (Q7 stays open; a candidate note only), MCP `list_changed` and elicitation prototype (Q4), community schema converters (Q3), streaming (Q11), rate limits (Q9), any CLI. If an increment seems to need one of these, stop and flag instead of building.

## Ground rules for the implementing agent

1. **Docs-first discipline.** N1 (canon) merges before any code. Every public-API addition lands in the same PR as its reference-page update and is recorded in ADR-013 (package) or ADR-014 (as-built deltas, mirroring ADR-012's format).
2. **CI gates are the spec.** `pnpm build && pnpm test && pnpm typecheck && pnpm check:boundaries && pnpm check:api && pnpm check:docs && pnpm docs:build` must be green at every increment. `check:api` compares exports against a hard-coded `REQUIRED` map in `scripts/check-api-surface.mjs` — extend that map when adding APIs. `check:boundaries` has a per-package `FORBIDDEN_IMPORTS` map — add a `postgres` entry (see N2).
3. **SI-tagged tests are untouchable** (may be extended, never deleted/weakened).
4. **Conventions:** ESM-only, Node ≥ 20.19, TS strict, tsup builds, vitest (root config discovers package suites), pnpm. New package.json mirrors `packages/ai-sdk/package.json` (independence disclaimer in description, `prepublishOnly` license copy, repository/homepage/bugs URLs, `publishConfig.access: public`).
5. **One changeset per user-visible change** (`pnpm changeset`), written past-tense, terse.

## Dependency graph

```text
N1 canon (Q8, ADR-013)
 └─► N2 postgres scaffold + coordinator contract suite
      ├─► N3 PgApprovalCoordinator
      └─► N4 PgAuditSink
N5 core/mcp polish        (independent; parallel to N2–N4)
N6 docs/recipes wave      (independent; parallel to N2–N5)
 └─► N7 release mechanics (needs all of the above)
```

---

## N1 — Canon

**Scope.** Record the decisions this release implements.

1. `docs/open-questions.md` Q8 → **RESOLVED (0.2)**: ship one reference package `@orpc-agent/postgres` exporting both the approval coordinator and the audit sink (supersedes the two-package placeholder names). Rationale: both are dep-free SQL glue over the same query seam; the "smallest coherent architecture" argument of ADR-009 applies. Recipes in the guides remain as the custom-store path.
2. New **ADR-013: Postgres reference persistence package**. Context (Q8 + first-consumer demand) → decision → alternatives (recipes-only; two packages; bundled driver) → consequences. The decision must pin these bounds:
   - Driver-agnostic: the package's only runtime dependency is `@orpc-agent/core` (`workspace:^`); it never imports `pg`. Input seam is a minimal query function; a `pg.Pool` is accepted via a documented one-line wrapper.
   - DDL exported as strings + doc snippet; **no migrations framework** (keeps the "bundled databases" non-goal intact — the app owns its schema lifecycle).
   - All time comparisons use the coordinator's injected clock (`now` option) passed as SQL parameters, never the DB's `now()` — preserves the "expiry is evaluated against the coordinator's clock" contract and test clock injection.
   - Batching in the audit sink must not void strict mode: `capability.started` is always written through and awaited (see N4).
3. `docs/open-questions.md` Q7: append a note — Mastra is the leading candidate for the first workflow adapter (production-consumer demand; app-process suspend/resume model is the cheapest conformant target); decision still deferred until the pattern is proven app-side.
4. `ROADMAP.md`: mark the 0.2 persistent-store line as "in progress → resolved by ADR-013"; leave the other 0.2 lines as-is (they are not in this release).

**Docs affected.** open-questions.md, architecture/decisions.md, ROADMAP.md.
**Acceptance.** `check:docs` green; ADR-013 follows the existing record format.

## N2 — Package scaffold + coordinator contract suite

**Scope.**
- `packages/postgres/`: package.json (name `@orpc-agent/postgres`, version `0.0.0` — changesets' `linked` lifts it to 0.2.0 at release; description: "Postgres reference implementations of the oRPC Agent approval coordinator and audit sink. Independent community project, not affiliated with or endorsed by the oRPC maintainers."), tsconfig, tsup.config, vitest.config, README (mirror sibling structure), `src/index.ts` stub.
- `scripts/check-boundaries.mjs`: add `postgres: [/^ai($|\/)/, /^@modelcontextprotocol\//, /^@opentelemetry\//, /^@orpc-agent\/(?!core)/, /^pg$/]` — the `pg` ban structurally enforces driver-agnosticism (tests import `@electric-sql/pglite`, allowed).
- `scripts/check-api-surface.mjs`: add the `postgres` entry as APIs land (N3/N4 list them).
- **Contract suite:** extract the in-memory coordinator's behavioral tests (locate them under `packages/core`) into `test-fixtures/approval-coordinator-contract.ts` — a parameterized `describe`-block factory over `(makeCoordinator, clock)`, following the `test-fixtures/conformance.ts` precedent (in-repo shared infra, not a public export; ADR-012 item 10). Cover: create/duplicate-id rejection; get unknown → null; decide happy/reject paths; decide guards (non-pending, expired-at-decide, malformed approver, invalid status); markConsumed happy path; markConsumed guards (not approved, already consumed); lazy expiry via injected clock on get/list/decide; list filters (status incl. computed `expired`, capabilityId, actorId); returned records are detached copies. Core's in-memory tests then consume the same factory (retrofit, like M5 did).

**Tests.** Contract suite green against `createInMemoryApprovalCoordinator`.
**Acceptance.** Build/boundaries/api checks green with the stub package.

## N3 — `PgApprovalCoordinator`

**Scope.** `packages/postgres/src/approvals.ts`.

**Public API** (add to `check-api` map and `docs/reference/`):

```ts
export type PgQuery = (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export type PgApprovalCoordinatorOptions = {
  query: PgQuery;
  /** Optionally schema-qualified; validated as [a-z_][a-z0-9_]* segments. Default "orpc_agent_approvals". */
  table?: string;
  now?: () => Date;
};

export function createPgApprovalCoordinator(options: PgApprovalCoordinatorOptions): ApprovalCoordinator;
export const APPROVALS_DDL: string;
```

**DDL** (the exported string; table name interpolated after identifier validation):

```sql
create table if not exists orpc_agent_approvals (
  id                       text primary key,
  capability_id            text not null,
  surface                  text not null,
  actor                    jsonb not null,          -- full Actor
  input                    jsonb,                   -- validated input, verbatim
  input_hash               text not null,
  reasons                  jsonb not null,
  types                    jsonb not null,
  risk                     text not null,
  side_effect              text not null,
  status                   text not null,           -- pending|approved|rejected|expired|cancelled|consumed
  requested_at             timestamptz not null,
  expires_at               timestamptz not null,
  decided_by               jsonb,
  decided_at               timestamptz,
  decision_comment         text,
  consumed_by_execution_id text
);
create index if not exists orpc_agent_approvals_status_idx on orpc_agent_approvals (status, expires_at);
create index if not exists orpc_agent_approvals_capability_idx on orpc_agent_approvals (capability_id, requested_at);
```

**Semantics (each mirrors the in-memory implementation and the contract in `guides/human-approval.md#production-coordinator`):**

| Method | SQL shape | Notes |
|---|---|---|
| `create` | `INSERT … ON CONFLICT (id) DO NOTHING RETURNING *`; 0 rows → throw `Approval "<id>" already exists` | status `'pending'` |
| `get` | `SELECT` with computed status: `CASE WHEN status='pending' AND expires_at <= $now THEN 'expired' ELSE status END` | no write-on-read; unknown → `null` |
| `decide` | validate decision status + well-formed approver (local 5-line guard — core does not export `isWellFormedActor`), then CAS: `UPDATE … SET status=$s, decided_by=$a, decided_at=$now, decision_comment=$c WHERE id=$1 AND status='pending' AND expires_at > $now RETURNING *`; 0 rows → re-read (with computed status) and throw the in-memory message (`not found` / `is not pending (status: …)`) | audit emission stays in the runtime's `wrapCoordinator`; the store never emits |
| `markConsumed` | CAS: `UPDATE … SET status='consumed', consumed_by_execution_id=$2 WHERE id=$1 AND status='approved' AND consumed_by_execution_id IS NULL RETURNING *`; 0 rows → re-read and throw with status detail | **the T8 obligation**; single-statement compare-and-set, no transaction, no `FOR UPDATE` |
| `list` | CTE computing the expiry-adjusted status, then filter on the computed column (`status`, `capability_id`, `actor->>'id'`) | `filter.status: "expired"` must match computed-expired rows; `"pending"` must exclude them |

- Row → `ApprovalRecord` mapping revives `timestamptz` to `Date` and reshapes `decided_* → decision`.
- **Every** time comparison uses `$now` from `options.now()` (ADR-013 bound), never SQL `now()`.
- **JSON round-trip caveat (document, don't fix):** persisted inputs revive as plain JSON — a `Date` inside an input comes back as an ISO string. Resume re-validates before consumption (ADR-001 addendum), so a `z.date()` schema fails safe rather than silently drifting. The package README and `docs/adapters/postgres.md` must tell approval-gated capabilities to use string/ISO datetime schemas (`z.iso.datetime()`) for date-bearing inputs.

**Tests.**
- Contract suite from N2 against pglite (`@electric-sql/pglite` devDep; small `PgQuery` adapter over `pglite.query`).
- Concurrency: `Promise.all` of two `markConsumed` / two `decide` on one record — exactly one succeeds (statements serialize; the CAS predicate does the work).
- Real-Postgres run: the same suite plus a genuine two-connection race (two `pg` Pool clients, concurrent `markConsumed`) behind `describe.skipIf(!process.env.TEST_DATABASE_URL)`; `pg` as devDep. Add a Postgres service container to the CI test job if the workflow edit is straightforward; otherwise document the env-gated suite in CONTRIBUTING and leave CI on pglite.
- DDL executes cleanly on pglite and (when env present) real PG; identifier validation rejects `"x; drop table"`.

**Docs affected.** New `docs/adapters/postgres.md` (usage, Pool wrapper one-liner, DDL snippet, caveats, contract points); `guides/human-approval.md#production-coordinator` → package first, hand-rolled recipe second; `reference/configuration.md` approvals row; sidebar entry in `docs/.vitepress/config.ts` (match existing adapter entries).
**Acceptance.** Contract suite green on in-memory + pglite; T8 race test green where enabled.

## N4 — `PgAuditSink`

**Scope.** `packages/postgres/src/audit.ts`.

**Public API:**

```ts
export type PgAuditSinkOptions = {
  query: PgQuery;
  table?: string;                              // default "orpc_agent_audit_events"
  /** Terminal events only; capability.started ALWAYS writes through awaited (ADR-013). */
  batch?: { size?: number; flushMs?: number }; // defaults 50 / 250
};

/** Callable as an AuditSink; carries flush/close for graceful shutdown. */
export type PgAuditSink = AuditSink & { flush(): Promise<void>; close(): Promise<void> };

export function createPgAuditSink(options: PgAuditSinkOptions): PgAuditSink;
export const AUDIT_DDL: string;
```

**DDL:** append-only — `id bigint generated always as identity primary key`, `type text`, `at timestamptz`, `surface text`, `actor_id text`, `actor_kind text`, `execution_id text`, `capability_id text`, `correlation_id text`, `input_hash text`, `data jsonb`; indexes `(capability_id, at)`, `(actor_id, at)`, `(execution_id)` per `guides/auditing.md`.

**Semantics.**
- No `batch` option: every event is one awaited `INSERT`; the returned promise settles with it (strict mode works unmodified).
- With `batch`: `capability.started` bypasses the buffer (insert awaited — this is what makes strict's `emitAwaited` guarantee hold, see `runtime/audit.ts`); all other events enqueue and their returned promises settle **at flush** (multi-row `INSERT`, flush on size/timer/`flush()`/`close()`; timer `unref`'d). Flush failure rejects all held promises so the emitter routes each to `onSinkError`. Errors always propagate by rejection — the sink never swallows.
- Sink is payload-free by construction: it maps only envelope fields + `data` (SI-10 upheld by the event contract, not re-checked here).

**Tests.** Insert mapping per event type (fixture events from `@orpc-agent/testing` or hand-built); strict-mode integration: real runtime with `{ sinks: [pgSink], strict: true }` on pglite — `capability.started` row exists before handler runs (observable via a handler that queries the table), sink failure → `AUDIT_UNAVAILABLE`; batching: order preserved, size/timer flush, started-bypass proven under `batch`, flush-failure → per-event `onSinkError`; `close()` flushes.
**Docs affected.** `docs/adapters/postgres.md` §audit; `guides/auditing.md#minimal-wiring` → package first; `reference/configuration.md` audit row.
**Acceptance.** Strict + batched configurations both proven; `check:docs` green.

## N5 — Core/MCP polish

Three independent changes; each gets its own changeset and an ADR-014 line (create ADR-014 "As-built API deltas for v0.2" with the first landed item, mirroring ADR-012's format).

**N5a — JSON Schema conversion memo.**
`packages/core/src/schema/index.ts`: WeakMap-memoize successful `toJsonSchema` conversions (key: the schema object). `registerSchemaConverter` resets the memo (a re-registered vendor may change output). `describePipeline` (`runtime/describe.ts`) wraps the cached value in `structuredClone` when building each descriptor so callers mutating `descriptor.inputSchema` can't poison the cache. Motivation: `describe()` currently reconverts every exposed schema on every call — at ~46 aiSdk capabilities that's per-chat-turn overhead. Policies still re-run per call (SI-2 untouched — conversion is deterministic, evaluation is not).
*Tests:* conversion function called once per schema across repeated `describe` (spy); descriptor mutation isolated; `registerSchemaConverter` after a conversion produces the new output.

**N5b — Startup footgun warnings.**
`createAgentRuntime` gains `warnings?: boolean` (default `true`). When `true`, emit `console.warn` (once each, at construction) for:
1. Approvals coordinator defaulted to in-memory **and** ≥ 1 registry capability has `meta.approval.required === true` → "approval records will not survive restarts; pass approvals.coordinator (e.g. @orpc-agent/postgres) or warnings:false".
2. No audit sinks **and** ≥ 1 capability with sideEffect `write|destructive|external` exposed to `aiSdk` or `mcp` → "no audit trail will be stored; configure audit sinks or warnings:false".
Static knowledge only (policies are opaque); never throws; never changes behavior.
*Tests:* each condition fires exactly once; `warnings: false` silences; well-configured runtime warns nothing.
*Docs:* `reference/configuration.md` (new row), `guides/auditing.md` + `guides/human-approval.md` one-line mention.

**N5c — MCP `authInfo` typing.**
`packages/mcp/src/index.ts`: type `MCPSession.authInfo` as the MCP SDK's `AuthInfo` (`@modelcontextprotocol/sdk/server/auth/types.js`) instead of `unknown`. If the pinned SDK version doesn't export it from a stable subpath, declare a local structural `AuthInfo` matching the SDK's shape and document the provenance. Type-only change; record in ADR-014.
*Docs:* `adapters/mcp.md` options table note.

**N5d (docs-only) — approval expiry guidance.**
`guides/human-approval.md` + `reference/configuration.md`: call out that the 15-minute `approvalExpiresInMs` default suits present-human confirmation; dashboard-latency approvals should raise it (runtime default or per-gate `expiresInMs`).

**Acceptance.** `check:api` updated for any new export; all SI tests green; ADR-014 records N5a–N5c.

## N6 — Docs/recipes wave

Four items; each is one PR; keep the repo's voice (terse, normative, worked examples). All new pages get sidebar entries.

**N6a — `docs/guides/headless-invocations.md`** (cron/scripts). Content: `direct` is the intended surface (quote `adapter-model.md`); ~30-line runner — build `Actor` (`kind: "service"`, one distinct id per job, e.g. `svc.bank-sync`, from deployment trust: env/secret, never model-adjacent — SI-3 note), `runtime.invoke(id, input, { actor, context, surface: "direct", correlationId: runId })`, envelope switch → exit codes (completed 0; failed 1 + `publicMessage`; approval-required = misconfiguration for unattended jobs — gate approval policies on surface/actor so service actors pass). Policy example: `requireApproval` only when `surface !== "direct"` or `actor.kind === "user"`. Render-cron deployment notes; strict-audit interaction (DB down ⇒ run fails closed — pair with retry/alerting). Cross-link `authorization.md#service-accounts-and-automations`.

**N6b — `docs/adapters/ai-sdk.md` § "Host loops with their own approval UX".** One authority, and it must be the governed runtime: host-loop approval (e.g. Mastra `requireApproval`) decides pre-invoke on raw args — no canonical hash (SI-5), no coordinator record, no audit events, no expiry, no self-approval check. Rules: never enable host tool-approval for governed tools (double prompts + shadow approvals); render the `approval-required` envelope (typed `AISDKToolResult`) from stream tool-results or a pending-approvals fetch; present-human confirmation → inline `approvals.handler`, deferring (return `undefined`) manager-type gates to the coordinator (ADR-006 addendum). Link the Mastra example.

**N6c — `docs/guides/mcp-authentication.md`.** Spec-first resource-server guide: the adapter's seam is `createContext` (`verifyToken → { actor, context }`); no AS ships (non-goal, `package-boundaries.md#non-responsibilities`). Sections: token validation via JWT/JWKS and via introspection (complete `verifyToken` snippets); **worked example: Better Auth's `mcp` plugin as the authorization server** (config snippet + wiring into `createContext`) — presented as one worked pairing, not a normative blessing; static service-token path for machine clients (`kind: "service"`, least-privilege attributes); token→`Actor` mapping example incl. `attributes` for org/tenant; pitfalls (shared super-actor, identity from arguments — SI-3, anonymous default refusal). Link from `adapters/mcp.md`. Guide only — **no new example workspace** in 0.2.

**N6d — `docs/guides/workflow-steps.md`** (long-running jobs as governed steps). The blessed interim for minutes-long syncs while Q11 is open: slice the job into per-batch/per-page capabilities; engine (Mastra workflow shown) calls `runtime.invoke(…, { surface: "workflow", correlationId: runId })` per step — requires `expose.workflow: true`; per-step `timeoutMs`; one logical job = N audit events stitched by `correlationId` (intended model — progress becomes visible in audit); a gated step returns `approval-required` → engine suspends, app decides, engine resumes via `runtime.resume`; idempotency notes for replayed steps (`meta.idempotent`, SI-11). Close with: the packaged workflow adapter remains open (Q7); this recipe is engine-agnostic.

**Acceptance.** `docs:build` + `check:docs` green; every code snippet type-checks against the published API (compile snippets in a scratch test where practical).

## N7 — Release mechanics

**Scope.**
1. Verify one changeset exists per change; add a final release changeset if any package lacks a bump — **all six packages must bump minor** so `linked` releases everything at 0.2.0.
2. ADR-014 finalized (every as-built delta of this release).
3. Status flips: `ROADMAP.md` (0.2 section → shipped, contents listed; unshipped 0.2 roadmap lines stay under "Next"); `docs/open-questions.md` statuses (Q8 resolved); README package table + any version-pinned prose; `docs/adapters/postgres.md` status line → "Implemented in v0.2".
4. Full gate: `pnpm build && pnpm test && pnpm typecheck && pnpm check:boundaries && pnpm check:api && pnpm check:docs && pnpm docs:build`.
5. `pnpm changeset version` → review the lockstep bump → commit → release via CI on main (needs `NPM_TOKEN`/`RELEASE_TOKEN`) or `pnpm release` locally, per Q1's recorded flow.

**Acceptance = release checklist:**
- [ ] All six packages at 0.2.0, published, provenance intact
- [ ] Coordinator contract suite green: in-memory, pglite, (env-gated) real PG incl. two-connection T8 race
- [ ] Strict-mode audit proof with the pg sink, batched and unbatched
- [ ] No SI-tagged test weakened; boundary/api/docs checks green
- [ ] ADR-013 + ADR-014 merged; Q7 note, Q8 resolution, ROADMAP flips done
- [ ] Four N6 pages live; docs deploy green on Vercel

## Decisions taken (veto before starting)

1. One package `@orpc-agent/postgres` (not `approvals-postgres` + `audit-postgres`).
2. Test infra: pglite default everywhere; real-PG suite env-gated (`TEST_DATABASE_URL`); CI PG service optional.
3. Consume-once via single-statement conditional `UPDATE` (no `SELECT … FOR UPDATE`).
4. MCP auth ships as a guide with a Better Auth worked example — no runnable example workspace.
5. Startup warnings on by default, `warnings: false` opt-out, never fatal.
6. Mastra workflow recipe written now, engine-agnostic; the Q7 adapter decision stays open.
7. 0.2.0 ships without the workflow adapter, MCP `list_changed`/elicitation, or community converters.
