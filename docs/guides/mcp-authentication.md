# Guide: MCP authentication

> Integration guide for the `createContext` seam (typed `authInfo`). oRPC Agent ships **no authorization server** — that is a permanent non-goal ([package boundaries](../architecture/package-boundaries.md#orpc-agent-mcp), roadmap non-goals). This page shows how to put one in front of the MCP adapter.

The adapter's contract is one function: `createContext(session)` receives the transport's **authenticated** session and returns `{ actor, context }` — or nothing, and the session is refused ([adapters/mcp](../adapters/mcp.md)). Everything on this page happens before or inside that function. `session.authInfo` is the MCP SDK's `AuthInfo` type (`token`, `clientId`, `scopes`, `expiresAt`), so verification code works with real fields.

## The shape, per the MCP authorization spec

Remote MCP clients (Claude, IDEs) expect the OAuth arrangement the MCP spec describes: your MCP endpoint is a **resource server**; an **authorization server** issues the tokens; the endpoint advertises its AS via protected-resource metadata so clients can discover it (modern clients handle dynamic registration and the browser dance from there).

```text
MCP client ──(1) discover AS via protected-resource metadata──► your MCP endpoint
    │                                                                 ▲
    ├──(2) register + authorize + obtain token──► authorization server │
    └──(3) Streamable HTTP + Bearer token────────────────────────────►─┘
                                    verifyToken → createContext → { actor, context }
```

The transport layer (the MCP SDK's Streamable HTTP server transport behind your HTTP framework) extracts and pre-validates the bearer token into `session.authInfo`; `createContext` turns the verified principal into an `Actor` and your app context.

## Validating the token

Two standard strategies; both end in the same `createContext`:

**JWT + JWKS** (self-contained tokens, no per-request call to the AS):

```ts
import { createRemoteJWKSet, jwtVerify } from "jose";

const jwks = createRemoteJWKSet(new URL("https://auth.example.com/.well-known/jwks.json"));

async function verifyToken(token: string) {
  const { payload } = await jwtVerify(token, jwks, {
    issuer: "https://auth.example.com",
    audience: "https://api.example.com/mcp",   // token bound to THIS resource
  });
  return payload; // { sub, scope, ... }
}
```

**Introspection** (opaque tokens; the AS is the source of truth, revocation is immediate):

```ts
async function verifyToken(token: string) {
  const response = await fetch("https://auth.example.com/oauth2/introspect", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: CLIENT_BASIC },
    body: new URLSearchParams({ token }),
  });
  const payload = await response.json();
  if (!payload.active) throw new Error("token inactive");
  return payload;
}
```

Either way, the wiring into the adapter is identical:

```ts
const mcp = createMCPServer(runtime, {
  serverInfo: { name: "acme-finance", version: "1.0.0" },
  createContext: async (session) => {
    if (!session.authInfo?.token) return null;            // refused — no anonymous default
    const principal = await verifyToken(session.authInfo.token).catch(() => null);
    if (!principal) return null;
    const actor = actorFrom(principal);                    // see below
    return { actor, context: await createAppContext(actor) };
  },
});
```

## Worked example: Better Auth as the authorization server

[Better Auth](https://better-auth.com)'s `mcp` plugin turns an app's existing auth into an MCP-ready authorization server — OAuth endpoints, client registration, and the discovery metadata MCP clients look for — which fits the common case where the MCP endpoint belongs to an app that already has users and sessions:

```ts
// auth.ts — the application's Better Auth instance, now also an AS
import { betterAuth } from "better-auth";
import { mcp } from "better-auth/plugins";

export const auth = betterAuth({
  database: /* your db */,
  plugins: [mcp({ loginPage: "/sign-in" })],
});
```

On the MCP endpoint, validate the bearer token with the plugin's session helper (or standard introspection against the same instance) and map to an actor — the exact helper names are Better Auth's API, see their MCP plugin docs:

```ts
createContext: async (session) => {
  if (!session.authInfo?.token) return null;
  const mcpSession = await auth.api.getMcpSession({
    headers: new Headers({ authorization: `Bearer ${session.authInfo.token}` }),
  });
  if (!mcpSession) return null;
  const actor = {
    id: mcpSession.userId,
    kind: "user" as const,
    attributes: { scopes: mcpSession.scopes },
  };
  return { actor, context: await createAppContext(actor) };
},
```

One worked pairing, not a blessing: any spec-conforming AS (Keycloak, Auth0, WorkOS, your own) slots into the same two functions.

## Machine clients: static service tokens

For a known integration (an internal script, a partner system) the full OAuth dance is overhead. A static bearer token compared in constant time, mapped to a **scoped service actor**, is legitimate — what matters is least privilege and attribution, not the protocol:

```ts
createContext: async (session) => {
  const principal = SERVICE_TOKENS.get(hash(session.authInfo?.token ?? ""));
  if (!principal) return null;
  return {
    actor: {
      id: principal.id,                        // "svc.reporting-bot" — one per integration
      kind: "service",
      attributes: { permissions: principal.permissions },
    },
    context: await createAppContext(principal),
  };
},
```

Rotate the tokens like any credential, and never one shared super-actor for all MCP traffic ([authorization](../security/authorization.md#service-accounts-and-automations)).

## Mapping tokens to actors

The `Actor` is what policies target and audit records — invest a minute in the mapping:

- `id`: the stable principal id (`sub` claim / user id / service name) — not the token.
- `kind`: `"user"` for a human behind OAuth, `"service"` for machine integrations.
- `attributes`: what your policies and middleware need — org/tenant id, permissions, token scopes. The runtime never interprets them (they're yours); putting scopes here lets a policy deny a capability the token was never granted.

## Pitfalls

- **Identity from arguments.** Nothing a model sends in `tools/call` may influence the actor (SI-3) — identity is settled at session establishment, full stop.
- **Skipping audience validation.** A JWT for a *different* resource of the same AS must not pass; validate `aud`.
- **Anonymous fallbacks.** `createContext` returning a default actor for unauthenticated sessions reintroduces ambient identity; return nothing and let the adapter refuse. If you truly run an open read-only endpoint, model it explicitly (`kind: "anonymous"`) over a registry filtered to reads ([narrowed deployments](capability-exposure.md#narrowed-deployments)).
- **Treating session establishment as the last identity check.** It is the last time `createContext` runs, not the last time the credential is examined: the adapter re-reads `authInfo.expiresAt` on every request and refuses once it has passed ([session lifetime](../adapters/mcp.md#session-lifetime)). Anything with a shorter horizon than the token — a revocation, a permission change — is still yours to handle, and short token lifetimes are how you get the adapter to notice.
- **Approval decisions over MCP.** Deciding stays in your app, never exposed as a capability to the same clients (SI-4; [adapters/mcp](../adapters/mcp.md#result-shape)).

## Related

- [Adapter: MCP](../adapters/mcp.md) · [Security: authorization](../security/authorization.md) · [Threat model](../security/threat-model.md)
