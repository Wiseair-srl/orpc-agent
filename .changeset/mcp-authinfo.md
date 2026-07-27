---
"@orpc-agent/mcp": minor
---

`MCPSession.authInfo` is now typed as the MCP SDK's `AuthInfo` (was `unknown`) — `createContext` implementations get real `token`/`clientId`/`scopes` fields. Type-level only; no runtime change.
