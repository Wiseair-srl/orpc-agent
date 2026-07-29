# Mastra task board

A thin full-stack example: a team task board whose UI talks plain typed oRPC, plus a [Mastra](https://mastra.ai) chat agent that reaches the **same four procedures** through the oRPC Agent governed runtime — exposure, validation, policies, human approvals, redaction, audit.

The Mastra integration is the whole point, and it is small: `toAISDKTools(runtime, { actor, context })` produces AI SDK tools, and a Mastra `Agent` consumes them directly ([src/agent.ts](src/agent.ts)).

`@orpc-agent/ai-sdk` peer-depends on `ai@^5 || ^6` and is tested against both. This example pins `ai@^5`, which is the example's choice — a Mastra app on `ai@^6` wires up identically.

```text
you ──┬─ board UI ── typed oRPC client ──── /rpc ────────► procedures (middleware runs)
      │                                                        ▲
      └─ chat ── /api/chat ── Mastra Agent ── AI SDK tools ────┤
                              (OpenRouter, any model)          │ governed: exposure · validation
                                                               │ policies · approvals · redaction
you ── approvals panel ── /api/approvals ── decide + resume ───┘ audit ledger
```

## Run it

From the repository root (Node ≥ 22.13):

```bash
pnpm install && pnpm build
pnpm --filter mastra-task-board-example dev     # server :3000 + Vite :5173
```

AI features are optional and **model-agnostic** — bring an [OpenRouter](https://openrouter.ai/keys) key, pick any model:

```bash
cp examples/mastra-task-board/.env.example examples/mastra-task-board/.env
# edit .env: OPENROUTER_API_KEY=sk-or-...  (and optionally OPENROUTER_MODEL)
```

Without a key the board, approvals, and audit endpoints still work; the chat panel shows setup instructions instead.

No key handy? The scripted demo runs the real Mastra loop against the real runtime with a deterministic model:

```bash
pnpm --filter mastra-task-board-example demo
pnpm --filter mastra-task-board-example test
```

## What to try in chat

- “What's on the board?” — the agent lists tasks. Internal notes are **redacted** before output reaches the model (hover the `notes · hidden from model` tag on the board).
- “Move the flaky test task to done.” — plain governed write, audited.
- “Add an urgent task to call the datacenter.” — a **policy** turns urgent creates into approval requests.
- “Delete the launch announcement task.” — `tasks.delete` is destructive; a **static approval gate** suspends it until you click Approve. Approve → the runtime `resume`s and executes exactly once; Reject → nothing ran.

Every agent-side step lands in the audit ledger at the bottom. The board UI's own calls don't — they are ordinary application traffic on `/rpc`, which is exactly the architectural point.

## Files

| File | What it shows |
|---|---|
| [src/capabilities.ts](src/capabilities.ts) | Four procedures with `agent` metadata; one nested object is both the oRPC router and the capability registry |
| [src/policies.ts](src/policies.ts) | Conditional approval as a policy (`urgent` creates) |
| [src/agent.ts](src/agent.ts) | The entire Mastra integration: per-request tools → `new Agent(...)` |
| [src/server.ts](src/server.ts) | Hono server: `/rpc` (plain oRPC for the UI) + `/api/*` (chat, approvals, audit) |
| [src/app.ts](src/app.ts) | Registry, runtime, approval coordinator, audit sink |
| [web/](web) | Vite + React UI: board (typed oRPC client), chat with tool envelopes, approval cards, audit ledger |
| [test/](test) | Governance tests + a deterministic end-to-end Mastra loop (no key, no network) |
