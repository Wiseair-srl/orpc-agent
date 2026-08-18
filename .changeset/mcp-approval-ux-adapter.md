---
"@orpc-agent/mcp": minor
---

Approval UX over MCP, deciding still impossible on this surface (SI-4): `approvals.url` adds a deep link to your approver UI (plus `expiresAt`) on approval-required envelopes; opt-in `approvals.resumeTool` exposes an `approvals_resume` tool that executes an already-approved operation exactly once, bound to the session's actor and the `mcp` surface.
