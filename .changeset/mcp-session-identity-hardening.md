---
"@orpc-agent/mcp": patch
---

Harden per-session identity, both fixes aimed at long-lived public endpoints (Streamable HTTP with bearer-token auth):

- **Token expiry is re-checked on every request.** `createContext` still runs once per session, but the cached identity no longer outlives the credential behind it: the adapter now reads `authInfo.expiresAt` from the credential the transport verified for *that* request and refuses with `InvalidRequest` ("Unauthorized: the session's access token has expired") once it has passed, on `tools/call` and `tools/list` alike. Previously a token that expired mid-session kept working until the session ended — hours, on a long-lived session. The refusal evicts the entry, so a refreshed token on the same session re-runs `createContext` and continues. `authInfo` without `expiresAt` is unchanged: the adapter does not invent an expiry.

- **A closed session's identity is evicted.** Nothing removed cache entries before, so the map grew with every session a process had ever served. Both `connect()` and the underlying SDK server's close path are hooked, so eviction holds whether you connect through the handle or compose over `mcp.server` — including when that composition sets `server.onclose` itself.

No API change.
