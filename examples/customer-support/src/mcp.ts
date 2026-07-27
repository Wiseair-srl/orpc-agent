import { createMCPServer } from "@orpc-agent/mcp";
import { SESSIONS, actorFrom, type Session } from "./context";
import type { App } from "./app";

/**
 * The external MCP endpoint — read-only in effect: writes are simply not
 * exposed to the "mcp" surface (SI-1), and the mcp-read-only policy backstops
 * that decision (defense in depth).
 *
 * `authInfo` stands in for the verified OAuth principal a Streamable HTTP
 * deployment would supply; there is no anonymous default.
 */
export function makeMCPEndpoint(
  app: App,
  transportAuth?: { sessionToken?: string },
) {
  return createMCPServer(app.runtime, {
    serverInfo: { name: "acme-support", version: "0.1.0" },
    createContext: async (mcpSession) => {
      // Streamable HTTP supplies authInfo per session; in-process transports
      // (tests, stdio) hand the verified token in at construction instead.
      const principal = verifyOAuth(mcpSession.authInfo ?? { token: transportAuth?.sessionToken });
      if (!principal) return null;
      return { actor: actorFrom(principal), context: app.contextFor(principal) };
    },
  });
}

function verifyOAuth(authInfo: unknown): Session | null {
  const token = (authInfo as { token?: string } | undefined)?.token;
  if (token === "token-dana") return SESSIONS.dana;
  if (token === "token-priya") return SESSIONS.priya;
  return null;
}
