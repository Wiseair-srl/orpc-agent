# Guide: headless invocations (cron jobs and scripts)

> **Status:** Recipe for v0.1+ APIs — nothing here is new machinery. Surface semantics: [adapter model](../architecture/adapter-model.md#surface-identity); actor guidance: [authorization](../security/authorization.md#service-accounts-and-automations).

A scheduled job that runs one capability — a nightly bank sync, a weekly report — needs no adapter and no framework support: `direct` **is** the intended surface for server-side code calling `runtime.invoke` itself, and a cron process is server-side code. The whole runner is ~30 lines.

## The runner

```ts
// jobs/bank-sync.ts — invoked by your scheduler (Render cron, systemd timer, k8s CronJob)
import { runtime } from "../src/runtime";
import { createJobContext } from "../src/context";

// One distinct actor per job, from deployment trust (the process exists ⇒ the
// platform authenticated it). Never derived from anything model-adjacent (SI-3).
const actor = {
  id: "svc.bank-sync",
  kind: "service" as const,
  attributes: { permissions: ["transactions:import"] },
};

const runId = process.env.RENDER_INSTANCE_ID ?? `run_${Date.now()}`;

const result = await runtime.invoke(
  "transactions.import",
  { since: process.argv[2] ?? "auto" },
  {
    actor,
    context: await createJobContext(actor),
    surface: "direct",
    correlationId: runId,          // stitches this run's audit events together
    signal: AbortSignal.timeout(10 * 60_000),
  },
);

switch (result.status) {
  case "completed":
    console.log(`[${runId}] imported`, result.output);
    process.exit(0);
  case "failed":
  case "cancelled":
    console.error(`[${runId}] ${result.error.code}: ${result.error.publicMessage}`);
    process.exit(1);
  case "approval-required":
    // See below — for unattended jobs this is a policy misconfiguration.
    console.error(`[${runId}] suspended on approval ${result.approval.id} — fix the policy`);
    process.exit(2);
}
```

What you get for those 30 lines: the same five gates as every agent call (exposure, validation, policy, approval, application middleware), the same audit trail (`actor: svc.bank-sync` — attribution for free), the same timeout/cancellation envelope.

## Exposure and policy for unattended callers

The capability needs `expose: { direct: true, ... }` — a one-line, review-visible decision ([capability-exposure](capability-exposure.md)).

An unattended job cannot answer an approval prompt, so `approval-required` reaching a cron process means the gate was written too broadly. Gate on **who is asking**, not just what is asked — the policy sees both `surface` and `actor`:

```ts
export const gateAgentWrites = definePolicy("gate-agent-writes", ({ surface, actor, capability }) => {
  const modelDriven = surface === "aiSdk" || surface === "mcp";
  if (capability.meta.sideEffect !== "read" && modelDriven) {
    return requireApproval({ reason: `${capability.id} initiated from a model loop` });
  }
  return allow();  // trusted server code (direct/workflow) passes ungated
});
```

A service actor passing without approval violates nothing: SI-4 lists deterministic policy as a legitimate decision origin, and gate 5 (your middleware) still runs. What it must **not** be is one shared super-actor — one id per job (`svc.bank-sync`, `svc.invoice-sync`) keeps audit attribution real. Deny-listing risky verbs for automations stays available as a backstop (`actor.kind === "service" && capability.meta.risk === "critical" ⇒ deny`).

## Operational notes

- **Strict audit fails closed.** With `audit: { strict: true }`, a database blip aborts the run with `AUDIT_UNAVAILABLE` (T12 working as intended for a finance job). Pair the cron with retry/alerting rather than weakening the mode.
- **Retries are the runtime's, then the scheduler's.** `meta.retry` handles transient downstream failures inside one run (SI-11 eligibility applies — writes need `idempotent: true`); scheduler-level re-runs are new executions, visibly distinct in audit and stitched by `correlationId` if you reuse the run id.
- **Long jobs**: slice them into per-step capabilities instead of one two-hour invoke — [workflow-steps](workflow-steps.md).

## Anti-patterns

- **`kind: "user"` for a job** — actors describe what authenticated, not who wrote the code.
- **Building the actor from job *input*** — arguments are data; identity comes from the deployment boundary (SI-3).
- **Skipping the runtime "because it's trusted code"** — the governed path is one argument away and buys audit + policy parity with every other surface; the ungoverned oRPC path remains available where you explicitly want no governance.
