---
"@orpc-agent/ai-sdk": minor
---

Support Vercel AI SDK v6: the `ai` peer range widens from `^5.0.0` to `^5.0.0 || ^6.0.0`.

One code path, no compat shim — the APIs the adapter uses are unchanged across the majors. `tool()` keeps its overloads, `jsonSchema()` only widened its accepted input, and a `Record<string, Tool>` still satisfies `ToolSet`. `jsonSchema()` without an explicit `validate` performs no validation in either major, so the runtime remains the single validation authority on both.

CI now runs the package's suite and typecheck against both majors on every PR (`ai-sdk (ai v5)` and `ai-sdk (ai v6)`); the v6 leg resolves through an aliased `ai-v6` devDependency, so it is lockfile-pinned rather than a floating install, and the suite asserts which major it actually loaded.

`ai@6` ships its own tool-approval gate (`needsApproval`). The adapter does not set it: approval authority stays with the runtime, which binds it to a canonical input hash, records it with the coordinator and audits it. Approvals continue to reach the model as the `approval-required` envelope.
