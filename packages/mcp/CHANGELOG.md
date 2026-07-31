# @orpc-agent/mcp

## 2.0.0

### Patch Changes

- Updated dependencies [2f8f73f]
- Updated dependencies [2f8f73f]
- Updated dependencies [2f8f73f]
  - @orpc-agent/core@2.0.0

## 1.1.0

### Patch Changes

- b3cf603: Harden per-session identity, both fixes aimed at long-lived public endpoints (Streamable HTTP with bearer-token auth):

  - **Token expiry is re-checked on every request.** `createContext` still runs once per session, but the cached identity no longer outlives the credential behind it: the adapter now reads `authInfo.expiresAt` from the credential the transport verified for _that_ request and refuses with `InvalidRequest` ("Unauthorized: the session's access token has expired") once it has passed, on `tools/call` and `tools/list` alike. Previously a token that expired mid-session kept working until the session ended — hours, on a long-lived session. The refusal evicts the entry, so a refreshed token on the same session re-runs `createContext` and continues. `authInfo` without `expiresAt` is unchanged: the adapter does not invent an expiry.

  - **A closed session's identity is evicted.** Nothing removed cache entries before, so the map grew with every session a process had ever served. Both `connect()` and the underlying SDK server's close path are hooked, so eviction holds whether you connect through the handle or compose over `mcp.server` — including when that composition sets `server.onclose` itself.

  No API change.

## 1.0.0

### Patch Changes

- Updated dependencies [7751b9a]
  - @orpc-agent/core@1.0.0

## 0.3.0

### Patch Changes

- e3469e7: New package `@orpc-agent/cli` — capability inventory and CI drift gate (ADR-015).

  The binary `orpc-agent` answers two questions about a repository: what an agent can reach from it, and whether that changed in a pull request.

  - `orpc-agent inspect` prints the inventory; `snapshot` writes a deterministic snapshot file; `check` compares the application against it. Exit codes are contractual: 0 clean, 1 drift, 2 could not run.
  - Drift is classified, not merely detected: _widening_ (the agent gained reach or a control weakened), _narrowing_, _neutral_, with `--fail-on widening`. A `sideEffect` change counts as widening in both directions — declaring less than before stops policies keyed on the old value from matching — and `idempotent: false → true` is widening, being the flag that permits retrying a write.
  - The entry module is imported in a child process with `ORPC_AGENT_INSPECT=1` and a timeout; a function export is refused rather than called. TypeScript loads natively on Node ≥ 22.18, otherwise through the project's own `tsx`/`jiti` — neither is a dependency.
  - `--format github` emits annotations, `--format md` a pull-request table.
  - The tool documents what it cannot see: it does not evaluate policies, so it reports declarations, not reachability.

  Core: `defaultToolName` is now a public export. It had three copies (registry, MCP adapter, AI SDK adapter); both adapters now import it, so protocol naming has one implementation and tooling reports the adapters' actual mapping.

- Updated dependencies [e3469e7]
  - @orpc-agent/core@0.3.0

## 0.2.0

### Minor Changes

- 53b20a9: `MCPSession.authInfo` is now typed as the MCP SDK's `AuthInfo` (was `unknown`) — `createContext` implementations get real `token`/`clientId`/`scopes` fields. Type-level only; no runtime change.

### Patch Changes

- Updated dependencies [53b20a9]
  - @orpc-agent/core@0.2.0
