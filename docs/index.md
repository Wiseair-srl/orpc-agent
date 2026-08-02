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
    - theme: alt
      text: GitHub
      link: https://github.com/Wiseair-srl/orpc-agent

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

> **2.0, published to npm.** An independent community project — not affiliated with, endorsed by, or maintained by the oRPC project.

**New here?** [Getting started](getting-started.md) — from an existing oRPC app to a governed tool call in five steps.
**Want the idea first?** [Architecture overview](architecture/overview.md) — the thesis, the layers, the five core objects.
**Want to see it work?** [Customer-support agent](examples/customer-support-agent.md) — nine capabilities, three surfaces, one approval that a human decides.
**Upgrading from 1.x?** [Migration guide](migration/1-to-2.md) — one breaking change, and it may not affect you.

## Reading paths

Four ways in, depending on why you are here.

**"Should we adopt this?"**
[Architecture overview](architecture/overview.md) → [Security model](security/security-model.md) → [the worked example](examples/customer-support-agent.md) → [FAQ](faq.md)

**"I'm integrating it."**
[Getting started](getting-started.md) → [Defining capabilities](guides/defining-capabilities.md) → [Capability exposure](guides/capability-exposure.md) → the rest of the guides → [Reference](reference/core.md)

**"I'm reviewing its security."**
[Security model](security/security-model.md) (SI-1 … SI-12) → [Authorization](security/authorization.md) → [Prompt injection](security/prompt-injection.md) → [Sensitive data](security/sensitive-data.md) → [Idempotency and retries](security/idempotency-and-retries.md) → [Execution pipeline](architecture/execution-pipeline.md) → [Threat model](security/threat-model.md)

**"I want to know why it works this way."**
[Architecture overview](architecture/overview.md) → [Execution pipeline](architecture/execution-pipeline.md) → [Decision records](architecture/decisions.md)

New to the vocabulary? The [glossary](glossary.md) is short, and every distinction in it is load-bearing. Something not working? [Troubleshooting](guides/troubleshooting.md) is indexed by what you saw.
