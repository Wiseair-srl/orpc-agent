---
layout: home

hero:
  name: oRPC Agent
  text: Governed capabilities for AI agents
  tagline: Make agents first-class clients of your oRPC application — the same typed procedures, with explicit exposure, policies, approvals, audit, and tracing.
  image:
    src: /logo.svg
    alt: oRPC Agent
  actions:
    - theme: brand
      text: Get started
      link: /getting-started
    - theme: alt
      text: The worked example
      link: /examples/customer-support-agent
    - theme: alt
      text: Security model
      link: /security/security-model

features:
  - icon: 🧩
    title: Capabilities, not tools
    details: An ordinary oRPC procedure plus governance metadata is a capability. One definition serves your UI, AI runtimes, MCP clients, and tests — no duplicated schemas that drift.
    link: /concepts/capabilities
  - icon: 🚪
    title: Deny-by-default exposure
    details: Nothing is reachable on any surface without an explicit expose flag — and filtering is UX, never security. Every invocation re-checks everything at execution time.
    link: /guides/capability-exposure
  - icon: ⚖️
    title: Deterministic policies
    details: allow / deny / hide / require-approval with deny-wins precedence. Policies that throw or time out fail closed. Every stance lands in the audit record.
    link: /concepts/policies
  - icon: ✅
    title: Input-bound approvals
    details: Approvals hash-bind the exact validated input, execute at most once, expire, and reject self-approval. Models can trigger the flow; they can never decide it.
    link: /concepts/approvals
  - icon: 🎭
    title: Two-face errors
    details: A model-safe public face and a private diagnostic body. Hidden, unexposed, and nonexistent capabilities are externally indistinguishable.
    link: /concepts/errors
  - icon: 🔍
    title: Evidence built in
    details: Structured audit events and OpenTelemetry spans for every governed step — payload-free by default — plus a testing package that asserts governance with no LLM in the loop.
    link: /guides/auditing
---

> **Status:** v0.1 implemented and published to npm (`@orpc-agent/*` at 0.1.0). These documents are the source of truth the implementation was built from; where the build forced a change, the [decision records](architecture/decisions.md) carry an as-built addendum. Independent community project, not affiliated with the oRPC maintainers.

**Start here:** [Getting started](getting-started.md) · **The idea in one page:** [Architecture overview](architecture/overview.md) · **The worked example:** [Customer-support agent](examples/customer-support-agent.md) · **Full-stack with Mastra:** [Task board](examples/mastra-task-board.md)

## Documentation map

Audience key: **U** = application developers using the framework · **I** = implementers/contributors building it · **S** = security reviewers.

### Concepts — the mental model (U)

| Doc | Answers | Builds on |
|---|---|---|
| [capabilities](concepts/capabilities.md) | What is a capability; why not "tool"; granularity | — |
| [registry](concepts/registry.md) | Identity, inclusion, filtering | capabilities |
| [runtime](concepts/runtime.md) | What executes; the result envelope | capabilities |
| [context](concepts/context.md) | Actor vs execution context; `ctx.agent` | runtime |
| [policies](concepts/policies.md) | Decisions, phases, precedence — normative semantics | runtime |
| [approvals](concepts/approvals.md) | The lifecycle; input binding — normative semantics | policies |
| [errors](concepts/errors.md) | Two-face errors; stages; model feedback | runtime |
| [lifecycle](concepts/lifecycle.md) | One request end-to-end, narrated | all of the above |

### Architecture — normative design (I)

| Doc | Answers |
|---|---|
| [overview](architecture/overview.md) | Layers, boundaries, the five core objects |
| [execution-pipeline](architecture/execution-pipeline.md) | **The** stage-by-stage runtime spec (cited as "stage N") |
| [package-boundaries](architecture/package-boundaries.md) | Five packages, dependency rules, non-responsibilities |
| [adapter-model](architecture/adapter-model.md) | The four adapter obligations; conformance |
| [decisions](architecture/decisions.md) | ADR-001…012 |

### Security — binding invariants (S, U, I)

| Doc | Answers |
|---|---|
| [security-model](security/security-model.md) | SI-1…SI-12; the five gates; honest non-claims |
| [authorization](security/authorization.md) | Four layers; middleware authority; multi-tenancy |
| [prompt-injection](security/prompt-injection.md) | What's bounded, what isn't, what's yours |
| [sensitive-data](security/sensitive-data.md) | Five lenses; redaction defaults |
| [idempotency-and-retries](security/idempotency-and-retries.md) | Exact guarantees and non-guarantees |
| [threat-model](security/threat-model.md) | Assets, adversaries, T1–T15 |

### Adapters (U)

[ai-sdk](adapters/ai-sdk.md) · [mcp](adapters/mcp.md) · [opentelemetry](adapters/opentelemetry.md) · [testing](adapters/testing.md)

### Guides — task-oriented (U)

[defining-capabilities](guides/defining-capabilities.md) · [capability-exposure](guides/capability-exposure.md) · [adding-policies](guides/adding-policies.md) · [human-approval](guides/human-approval.md) · [application-context](guides/application-context.md) · [auditing](guides/auditing.md) · [testing-capabilities](guides/testing-capabilities.md) · [migrating-existing-tools](guides/migrating-existing-tools.md)

### Reference — API contracts (U, I)

[core](reference/core.md) · [metadata](reference/metadata.md) · [runtime](reference/runtime.md) · [events](reference/events.md) · [errors](reference/errors.md) · [configuration](reference/configuration.md)

### Project (I)

| Doc | Answers |
|---|---|
| [implementation/brief](implementation/brief.md) | The definitive build instructions for the coding agent |
| [implementation/milestones](implementation/milestones.md) | M1–M9 increments with acceptance criteria |
| [open-questions](open-questions.md) | Every unresolved decision, in one place |
| [roadmap](roadmap.md) | What's v0.1, what's later, what's never |
| [faq](faq.md) · [glossary](glossary.md) | Quick answers · enforced terminology |
| [contributing/](contributing/development.md) | Dev setup, docs style, releases, governance |

## Reading paths

- **"Should we adopt this?"** — [overview](architecture/overview.md) → [security-model](security/security-model.md) → [example](examples/customer-support-agent.md) → [faq](faq.md)
- **"I'm integrating it."** — [getting-started](getting-started.md) → guides in order → [reference](reference/core.md)
- **"I'm reviewing its security."** — all six security docs → [execution-pipeline](architecture/execution-pipeline.md) → [threat-model](security/threat-model.md)
- **"I'm implementing it."** — [implementation/brief](implementation/brief.md) → [execution-pipeline](architecture/execution-pipeline.md) → [reference](reference/core.md) → [milestones](implementation/milestones.md)
