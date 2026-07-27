# @orpc-agent/mcp

## 0.2.0

### Minor Changes

- 53b20a9: `MCPSession.authInfo` is now typed as the MCP SDK's `AuthInfo` (was `unknown`) — `createContext` implementations get real `token`/`clientId`/`scopes` fields. Type-level only; no runtime change.

### Patch Changes

- Updated dependencies [53b20a9]
  - @orpc-agent/core@0.2.0
