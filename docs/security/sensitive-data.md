# Sensitive data

> **Status:** Stable — 1.0.

Five places want to see execution data, with five different trust levels. The design principle: **each consumer gets the minimum it needs, and the defaults assume data is sensitive** (SI-9, SI-10). Redaction is subtractive work you opt out of, not protective work you must remember to add — with one honest exception: model-visible *outputs*, which only you can shape.

## The five lenses

| Lens | Sees by default | You control via |
|---|---|---|
| Model / adapter results | Validated output **after** `redact.output`; model-safe errors only | `redact.output`, output schema design |
| Traces | Ids, classifications, durations, outcome, error code — **no payloads** | Custom span attributes (deliberate opt-in) |
| Audit events | Envelope + hashes + decisions — **no payloads** | Custom sinks may enrich; on you |
| Approval UIs | `redact.approvalInput(input)` if defined, else validated input | `redact.approvalInput` |
| Server logs | Everything, including `cause` | Your logging discipline |

### Model-visible results

The model's context window is an *egress channel*: everything a capability returns can be repeated, summarized, or exfiltrated by a steered model ([prompt-injection.md](prompt-injection.md)). Two levers:

1. **Output schema design** — the strongest control. Don't return card numbers to anyone, and the model can't leak them.
2. **`redact.output`** — for fields legitimate app callers need but models don't:

```ts
redact: {
  output: (o) => {
    const c = o as Customer;
    return { ...c, email: mask(c.email), paymentMethods: undefined };
  },
}
```

Runs at pipeline stage 13, after output validation, before any adapter serialization — the unredacted value never leaves the runtime. One function per capability keeps review local: the reviewer of `customers.get` sees exactly what models may see.

### Traces

Core writes only the safe attribute set (`orpc_agent.capability_id`, `.surface`, `.outcome`, `.error_code`, …; full list in [reference/events.md](../reference/events.md#recommended-attributes)). Raw inputs/outputs are structurally absent — there is no configuration flag that turns them on globally, by design; adding payloads to spans requires writing code in your own tracing adapter, which is the review point. Actor *id* on spans is off by default in the OpenTelemetry adapter (`actorIdAttribute: false`) because trace backends often have broader access than audit stores.

### Audit events

Events carry `inputHash`, never input (SI-10). The hash lets you *prove* what was executed (compare against a value you hold) without *storing* what was executed. Deployments that need payload-level audit implement it deliberately in a sink, confronting retention and access questions in their own compliance context — the framework won't make that call implicitly ([ADR-010](../architecture/decisions.md#adr-010-audit-events-are-structured-and-storage-neutral)).

### Approval interfaces

Approvers need enough to decide — not everything. `redact.approvalInput` shapes the display (`{ orderId, amount, reason }`, not the customer's full record); the integrity hash still binds the **full** validated input, so display redaction never weakens SI-5. If displayed data would be so thin the approver can't decide, that's a signal the capability's input carries data it shouldn't.

### Error messages

Errors leak by construction unless designed not to: the two-face split (`publicMessage` vs `cause`) plus the `exposeToModel` gate means an unexpected `pg: duplicate key value violates constraint "users_ssn_key"` reaches logs, while the model reads "The operation failed." Write `publicMessage`s and declared-error messages knowing models and end users will read them ([concepts/errors.md](../concepts/errors.md)).

## Rules of thumb

- Classify at definition time: a capability touching PII is `risk: "high"` even when `sideEffect: "read"` — policies and reviews key off it.
- Redaction functions must be pure, total, and dumb (field masking/dropping). Business logic in redaction hides bugs.
- Never put personal data in capability *ids*, *tags*, or policy *codes* — those travel everywhere (spans, events, tool names).
- Test redaction like security code: the testing package asserts model-visible output shapes directly ([guides/testing-capabilities.md](../guides/testing-capabilities.md)).

## Related

- [security-model.md](security-model.md) · [reference/metadata.md](../reference/metadata.md#redact) · [guides/auditing.md](../guides/auditing.md)
