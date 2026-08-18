# Adapter: MCP

> Package: `@orpc-agent/mcp`. Peer: `@modelcontextprotocol/sdk`, `@orpc-agent/core`.

Exposes a runtime as a Model Context Protocol server. Surface id: **`mcp`**. This is the highest-exposure surface — callers are external processes you don't ship — so its docs lean harder on identity than any other adapter's.

## Usage

```ts
import { createMCPServer } from "@orpc-agent/mcp";

const mcp = createMCPServer(runtime, {
  serverInfo: { name: "acme-support", version: "1.0.0" },

  // Called once per session with the transport's AUTHENTICATED identity.
  createContext: async (session) => {
    const principal = await verifyToken(session.authInfo);   // your auth
    return {
      actor: { id: principal.userId, kind: "user", attributes: { orgId: principal.orgId } },
      context: await createAppContext(principal),
    };
  },
});

await mcp.connect(transport);   // stdio, Streamable HTTP — the app picks and hosts
```

`mcp.server` exposes the underlying MCP SDK server for advanced composition; `connect` starts the session and installs the identity-cache teardown (below).

### Options (`MCPServerOptions`)

| Option | Required | Notes |
|---|---|---|
| `createContext` | yes | Session → `{ actor, context }`. The adapter refuses to serve sessions where it returns nothing — there is no anonymous default; model anonymity explicitly (`kind: "anonymous"`) if you truly mean it. `session.authInfo` is the MCP SDK's `AuthInfo` — `token`, `clientId`, `scopes` as real fields. Wiring an authorization server: [guides/mcp-authentication.md](../guides/mcp-authentication.md) |
| `serverInfo` | no | Defaults to `{ name: "orpc-agent", version: <pkg> }` |
| `filter` | no | Listing-shaping only, not authorization (SI-2) |
| `toolNaming` | no | Default `.`→`_`; `meta.adapters.mcp.toolName` overrides; collisions throw |
| `approvals` | no | Approval UX: `url` (deep link to your approver UI) and `resumeTool` (execute-what-was-approved). Neither lets anything decide over MCP — [below](#closing-the-approval-loop-from-chat) |

## Protocol mapping

| MCP request | Behavior |
|---|---|
| `tools/list` | `runtime.describe("mcp", sessionIdentity)` → tool declarations: name (mapped), description (+ `" Requires approval."` when flagged), `inputSchema` (JSON Schema). Per-session: two clients with different actors can see different lists. The list is static within a session — dynamic `list_changed` is not implemented |
| `tools/call` | Name → capability id, then `runtime.invoke(id, args, { actor, context, surface: "mcp", signal })`. Raw arguments — the runtime validates (stage 5) |
| cancellation | MCP cancellation notifications abort the in-flight invocation's signal (SI-12) |
| resources / prompts | Not served, and not committed to |

`meta.adapters.mcp.annotations` passes through to the tool declaration (e.g., MCP's `readOnlyHint`/`destructiveHint` style annotations) — hints for clients, never governance.

## Result shape

MCP tool results carry a JSON content block with the **same envelope** as the AI SDK adapter (`ok` / `approval-required` / `error`), plus `isError: true` on the MCP result for the `error` status so protocol-level handling works. Two MCP-only fields ride on `approval-required`: `expiresAt` (always), and `url` when `approvals.url` is configured:

```jsonc
// tools/call result content (application/json)
{ "status": "approval-required", "approvalId": "apr_9",
  "message": "Awaiting approval: Refund of $649 exceeds $500. Share this link with the user so an authorized human can review and decide: https://acme.test/approvals/apr_9",
  "expiresAt": "2026-08-19T10:15:00.000Z",
  "url": "https://acme.test/approvals/apr_9" }
```

Concealment holds on this surface above all: unknown tool, unexposed capability, and policy-hidden capability are byte-identical `error` envelopes with `CAPABILITY_NOT_FOUND` (SI-8); `details`/`cause` never serialize (SI-9).

*Deciding* over MCP stays impossible: no MCP call can approve or reject anything, and no "decide approval" capability should ever be exposed to `mcp` (SI-4). What the adapter does offer is a way to keep the *conversation* whole — next section.

### Closing the approval loop from chat

The decision itself always happens in **your** application, by an authenticated human. Two opt-in options remove the UX seams around it:

```ts
const mcp = createMCPServer(runtime, {
  createContext,
  approvals: {
    // B: a deep link into your authenticated approver UI
    url: (record) => `https://admin.acme.test/approvals/${record.id}`,
    // C: let a session execute what a human has ALREADY approved
    resumeTool: true,   // or { name, description }
  },
});
```

**`approvals.url` — the human is one click away.** The approval-required envelope carries `url` and the message tells the model to hand it to the user. They click, land on *your* approver surface, authenticate with *your* IdP, decide there. The URL is a **locator, never an authority**: possession must not decide anything — gate the decide endpoint like any privileged operation, exactly as before ([human-approval](../guides/human-approval.md#_3-build-the-approver-surface)). Security posture is unchanged; only the walk to the dashboard is gone.

**`approvals.resumeTool` — the loop closes in-session.** Adds one synthetic tool (default `approvals_resume`; capability-name collisions throw at startup) that calls `runtime.resume` with two binding guards: `expectedActor` = the session's authenticated actor, `expectedSurface: "mcp"`. Resume is not decide — it acts only on a record already `approved`, executes exactly once (atomic consumption), as the original requester, with the input hash-bound at request time (SI-5). A model calling it can neither decide, nor change a byte, nor re-run.

The guards are what make relaying safe:

- **Requester-bound.** A session may execute only approvals *its own actor* requested (id + kind). Any other record — someone else's, or one requested on another surface — fails `APPROVAL_RESUME_MISMATCH`, serialized byte-identical to an unknown id (SI-8): probing with guessed ids learns nothing, and the attempt is audited under the caller's identity with the real code.
- **Surface-bound.** Only `surface: "mcp"` records resume here. An approval suspended in your AI-SDK loop keeps its output in that loop; cross-surface delivery is deliberately not offered.
- **Owner-visible states.** The record's own requester gets the real codes — `APPROVAL_PENDING` (retryable: the model can tell the user it's still waiting), `APPROVAL_REJECTED`, `APPROVAL_EXPIRED`, `APPROVAL_CONSUMED`.

Residual risk to name in your review: an injected model in the *requester's own session* could resume an approval the human granted but meant to abandon. Expiry bounds the window (`meta.approval.expiresInMs` — keep it short where the approver is present), rejection is terminal, and every resume is audited. If that residual is unacceptable for a capability, don't enable the tool — or keep the capability off `mcp` entirely.

MCP elicitation as a confirmation channel remains under evaluation ([Q4](../open-questions.md#q4)); these two options are the supported path today.

## Identity is the whole game here

Rules the adapter enforces or expects:

1. **No ambient identity.** Every session's actor comes from `createContext` verification of transport credentials (OAuth for Streamable HTTP; process trust for stdio in dev). The adapter never derives identity from tool arguments (SI-3).
2. **One actor per session, your choice of granularity** — the end user behind an OAuth token (best attribution), or a scoped service identity for machine integrations (`kind: "service"` with least-privilege attributes). Avoid one shared super-actor for all MCP traffic ([authorization](../security/authorization.md#service-accounts-and-automations)).
3. **Exposure to `mcp` is a bigger decision than to `aiSdk`.** Your own AI-SDK loop runs in your process against your prompts; MCP clients run other people's loops. The reference app exposes reads to both but keeps `orders.refund` off MCP entirely — a worked example of surface-specific exposure ([example](../examples/customer-support-agent.md)).

### Session lifetime

`createContext` runs **once per session** and its result is cached, so what the cache holds matters as much as what `createContext` returns. Two rules bound it:

- **Expiry is re-checked on every request, not once per session.** The adapter reads `authInfo.expiresAt` from the credential the transport verified for *that* request; when it has passed, the cached identity is dropped and the request is refused with `InvalidRequest` ("Unauthorized: the session's access token has expired"). It applies to `tools/call` and `tools/list` alike, since both are identity-derived. A token that expires mid-session therefore stops working at the next call rather than when the session ends — which, on a long-lived Streamable HTTP session, could be hours. A *refreshed* token on the same session re-runs `createContext` and continues, because the refusal already evicted the stale entry.

  `authInfo` with no `expiresAt` means the transport gave no expiry to enforce; the adapter does not invent one, and whether that credential is acceptable is your `createContext`'s call.

- **A closed session's identity is evicted.** Nothing else would remove it, so on a long-lived server the cache would otherwise grow with every session the process has ever served. Both `connect()` and the underlying server's close path are hooked, so eviction holds whether you connect through the handle or compose over `mcp.server` — including when your composition sets `server.onclose` itself.

Neither check replaces your token verification: the adapter enforces the expiry the transport reported, and `createContext` remains where signature, audience, scope, and revocation are decided ([mcp-authentication](../guides/mcp-authentication.md)).

## Deployment sketch

```text
Claude Desktop / IDE / other MCP client
        │  (OAuth: token issued by your IdP)
        ▼
your HTTP endpoint (Streamable HTTP transport)
        │  verifyToken → createContext → { actor, context }
        ▼
createMCPServer(runtime) ── runtime.invoke(surface: "mcp") ── your procedures
```

The app owns the endpoint, TLS, token issuance, and rate limiting (T5 in the [threat model](../security/threat-model.md)); the adapter owns protocol translation only.

## Related

- [Adapter model](../architecture/adapter-model.md) · [Security model](../security/security-model.md) · [Capability exposure guide](../guides/capability-exposure.md)
