import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  Actor,
  AgentRuntime,
  CapabilityDescriptor,
  CapabilityError,
  ExecutionResult,
} from "@orpc-agent/core";

/**
 * Adapter: Model Context Protocol. Surface id: "mcp" — the highest-exposure
 * surface; every session's actor comes from `createContext` verification of
 * transport credentials (docs/adapters/mcp.md).
 */

export type MCPSession = {
  sessionId?: string | undefined;
  /** Transport-verified auth info (e.g. from Streamable HTTP OAuth). */
  authInfo?: unknown;
};

export type MCPServerOptions<TContext = unknown> = {
  /**
   * Session → { actor, context }. Called once per session with the
   * transport's AUTHENTICATED identity. The adapter refuses to serve sessions
   * where it returns nothing — there is no anonymous default.
   */
  createContext: (
    session: MCPSession,
  ) =>
    | Promise<{ actor: Actor; context: TContext } | null | undefined>
    | { actor: Actor; context: TContext }
    | null
    | undefined;
  serverInfo?: { name: string; version: string };
  /** Listing-shaping only, not authorization (SI-2). */
  filter?: (descriptor: CapabilityDescriptor) => boolean;
  /** Replaces the default "." → "_" mapping. Per-capability meta overrides win. */
  toolNaming?: (capabilityId: string) => string;
};

export type MCPServerHandle = {
  /** The underlying MCP SDK server, for advanced composition. */
  server: Server;
  connect(transport: Transport): Promise<void>;
};

const DEFAULT_SERVER_INFO = { name: "orpc-agent", version: "0.1.0" };

export function createMCPServer<TContext = unknown>(
  runtime: AgentRuntime<TContext>,
  options: MCPServerOptions<TContext>,
): MCPServerHandle {
  if (typeof options?.createContext !== "function") {
    throw new TypeError("createMCPServer: options.createContext is required");
  }

  // Bidirectional name map over the whole registry (naming is meta-derived,
  // not actor-derived). Collisions are a startup error, never a silent rename.
  const nameToId = new Map<string, string>();
  const idToName = new Map<string, string>();
  for (const capability of runtime.registry.capabilities()) {
    const name =
      capability.meta.adapters?.mcp?.toolName ??
      options.toolNaming?.(capability.id) ??
      capability.id.replace(/\./g, "_");
    const existing = nameToId.get(name);
    if (existing !== undefined && existing !== capability.id) {
      throw new Error(
        `createMCPServer: tool name collision — "${existing}" and "${capability.id}" both map to "${name}"`,
      );
    }
    nameToId.set(name, capability.id);
    idToName.set(capability.id, name);
  }

  const server = new Server(options.serverInfo ?? DEFAULT_SERVER_INFO, {
    capabilities: { tools: {} },
  });

  // One identity per session, resolved once (per-session createContext).
  const identities = new Map<string, Promise<{ actor: Actor; context: TContext }>>();
  const identityFor = (extra: {
    sessionId?: string;
    authInfo?: unknown;
  }): Promise<{ actor: Actor; context: TContext }> => {
    const key = extra.sessionId ?? "__single_session__";
    let identity = identities.get(key);
    if (!identity) {
      identity = Promise.resolve(
        options.createContext({ sessionId: extra.sessionId, authInfo: extra.authInfo }),
      ).then((resolved) => {
        if (!resolved || !resolved.actor) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            "Unauthorized: no identity for this session",
          );
        }
        return resolved;
      });
      identity.catch(() => identities.delete(key));
      identities.set(key, identity);
    }
    return identity;
  };

  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    const { actor, context } = await identityFor(extra);
    const descriptors = await runtime.describe("mcp", { actor, context });
    const filtered = options.filter ? descriptors.filter(options.filter) : descriptors;
    return {
      tools: filtered.map((descriptor) => {
        const annotations = runtime.registry.get(descriptor.id)?.meta.adapters?.mcp?.annotations;
        return {
          name: idToName.get(descriptor.id) ?? descriptor.id.replace(/\./g, "_"),
          description:
            descriptor.description + (descriptor.requiresApproval ? " Requires approval." : ""),
          inputSchema: descriptor.inputSchema as { type: "object"; [key: string]: unknown },
          ...(annotations ? { annotations } : {}),
        };
      }),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const { actor, context } = await identityFor(extra);
    // Unknown names go to the runtime AS-IS: resolution misses produce the
    // concealed CAPABILITY_NOT_FOUND and are audited (probing is a signal).
    const capabilityId = nameToId.get(request.params.name) ?? request.params.name;
    const result = await runtime.invoke(capabilityId, request.params.arguments ?? {}, {
      actor,
      context,
      surface: "mcp",
      ...(extra.signal ? { signal: extra.signal } : {}),
    });
    const envelope = translateResult(result);
    return {
      content: [{ type: "text", text: JSON.stringify(envelope) }],
      isError: envelope.status === "error",
    };
  });

  return {
    server,
    connect: (transport) => server.connect(transport),
  };
}

type MCPEnvelope =
  | { status: "ok"; data: unknown }
  | { status: "approval-required"; approvalId: string; message: string }
  | {
      status: "error";
      error: { code: string; message: string; retryable: boolean; details?: unknown };
    };

/** Same envelope as the AI SDK adapter, plus isError at the protocol level. */
function translateResult(result: ExecutionResult<unknown>): MCPEnvelope {
  switch (result.status) {
    case "completed":
      return { status: "ok", data: result.output };
    case "approval-required": {
      const reasons = result.approval.reasons;
      return {
        status: "approval-required",
        approvalId: result.approval.id,
        message:
          reasons.length > 0 ? `Awaiting approval: ${reasons.join("; ")}.` : "Awaiting approval.",
      };
    }
    case "failed":
    case "cancelled":
      return { status: "error", error: serializeError(result.error) };
  }
}

/** The only two shapes a model client can ever receive (SI-9). */
function serializeError(error: CapabilityError): {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
} {
  if (!error.exposeToModel) {
    return { code: "INTERNAL_ERROR", message: "The operation failed.", retryable: false };
  }
  return {
    code: error.code,
    message: error.publicMessage,
    retryable: error.retryable,
    ...(error.code === "INPUT_INVALID" && error.details !== undefined
      ? { details: error.details }
      : {}),
  };
}
