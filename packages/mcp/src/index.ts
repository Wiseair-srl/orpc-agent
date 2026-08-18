import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { defaultToolName } from "@orpc-agent/core";
import type {
  Actor,
  AgentRuntime,
  ApprovalRecord,
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
  authInfo?: AuthInfo | undefined;
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
  /**
   * Approval UX. Deciding remains impossible over MCP (SI-4): these options
   * only route a human to YOUR approver surface, and let a session execute
   * what that human has already approved.
   */
  approvals?: {
    /**
     * Builds an absolute URL where an authorized human can review and decide
     * this approval — your authenticated approver UI, reachable one click
     * from the chat. Included in approval-required envelopes as `url` and
     * woven into the message so the model can hand it to the user. The URL
     * is a locator, never an authority: possession must not decide anything;
     * the decide endpoint authenticates like any privileged operation.
     */
    url?: (record: ApprovalRecord) => string | undefined;
    /**
     * Exposes one extra tool (default name "approvals_resume") that executes
     * an operation a human has ALREADY approved, exactly once. It cannot
     * approve, reject, or observe anyone else's approvals: the runtime
     * resumes only records whose requester matches this session's actor
     * (id + kind) and whose surface is "mcp"; anything else fails concealed,
     * byte-identical to an unknown id (SI-8), and is audited as
     * APPROVAL_RESUME_MISMATCH.
     */
    resumeTool?: boolean | { name?: string; description?: string };
  };
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
      defaultToolName(capability.id);
    const existing = nameToId.get(name);
    if (existing !== undefined && existing !== capability.id) {
      throw new Error(
        `createMCPServer: tool name collision — "${existing}" and "${capability.id}" both map to "${name}"`,
      );
    }
    nameToId.set(name, capability.id);
    idToName.set(capability.id, name);
  }

  const resumeTool = resolveResumeTool(options.approvals?.resumeTool);
  if (resumeTool) {
    const colliding = nameToId.get(resumeTool.name);
    if (colliding !== undefined) {
      throw new Error(
        `createMCPServer: tool name collision — capability "${colliding}" and approvals.resumeTool both map to "${resumeTool.name}"`,
      );
    }
  }
  const approvalUx: ApprovalUx = {
    ...(options.approvals?.url ? { url: options.approvals.url } : {}),
    ...(resumeTool ? { resumeToolName: resumeTool.name } : {}),
  };

  const server = new Server(options.serverInfo ?? DEFAULT_SERVER_INFO, {
    capabilities: { tools: {} },
  });

  // One identity per session, resolved once (per-session createContext).
  const identities = new Map<string, Promise<{ actor: Actor; context: TContext }>>();
  const identityFor = (extra: {
    sessionId?: string;
    authInfo?: AuthInfo;
  }): Promise<{ actor: Actor; context: TContext }> => {
    const key = extra.sessionId ?? "__single_session__";
    // The cache holds the identity, never the right to keep using it. Expiry
    // is re-checked on EVERY request from the credential the transport
    // verified for THAT request, so a token that expires mid-session stops
    // working at the next call rather than at the next session.
    if (isExpired(extra.authInfo)) {
      identities.delete(key);
      throw new McpError(
        ErrorCode.InvalidRequest,
        "Unauthorized: the session's access token has expired",
      );
    }
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

  // A closed connection's identities are dead, and on a long-lived server
  // nothing else would ever remove them — the map would grow with every
  // session the process has served. One Server serves one transport at a
  // time, so everything cached at close time belongs to the connection that
  // just ended.
  //
  // Hooked in two places on purpose: `server.onclose` covers apps that
  // connect the underlying SDK server themselves (`mcp.server`); the
  // transport hook in connect() covers apps that overwrite `server.onclose`
  // while still connecting through the handle. Clearing twice is harmless.
  server.onclose = () => identities.clear();

  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    const { actor, context } = await identityFor(extra);
    const descriptors = await runtime.describe("mcp", { actor, context });
    const filtered = options.filter ? descriptors.filter(options.filter) : descriptors;
    return {
      tools: [
        ...filtered.map((descriptor) => {
          const annotations = runtime.registry.get(descriptor.id)?.meta.adapters?.mcp?.annotations;
          return {
            name: idToName.get(descriptor.id) ?? defaultToolName(descriptor.id),
            description:
              descriptor.description + (descriptor.requiresApproval ? " Requires approval." : ""),
            inputSchema: descriptor.inputSchema as { type: "object"; [key: string]: unknown },
            ...(annotations ? { annotations } : {}),
          };
        }),
        // Synthetic, not a capability: listed for every session when enabled
        // (`filter` shapes capability listings only). It executes records this
        // session's actor already owns — nothing to conceal per-actor.
        ...(resumeTool
          ? [
              {
                name: resumeTool.name,
                description: resumeTool.description,
                inputSchema: RESUME_TOOL_INPUT_SCHEMA,
              },
            ]
          : []),
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const { actor, context } = await identityFor(extra);

    if (resumeTool && request.params.name === resumeTool.name) {
      const approvalId = (request.params.arguments as Record<string, unknown> | undefined)?.[
        "approvalId"
      ];
      if (typeof approvalId !== "string" || approvalId.length === 0) {
        return toCallToolResult({
          status: "error",
          error: {
            code: "INPUT_INVALID",
            message: "Input validation failed.",
            retryable: false,
            details: {
              issues: [{ path: ["approvalId"], message: "approvalId must be a non-empty string" }],
            },
          },
        });
      }
      // Execute-what-was-approved only: the guards bind the record to THIS
      // session's actor and to the mcp surface; the runtime conceals any
      // mismatch as if the id did not exist (SI-8) and audits the truth.
      // Deciding still has no path through this connection (SI-4).
      const result = await runtime.resume(approvalId, {
        context,
        expectedActor: actor,
        expectedSurface: "mcp",
        ...(extra.signal ? { signal: extra.signal } : {}),
      });
      return toCallToolResult(translateResult(result, approvalUx));
    }

    // Unknown names go to the runtime AS-IS: resolution misses produce the
    // concealed CAPABILITY_NOT_FOUND and are audited (probing is a signal).
    const capabilityId = nameToId.get(request.params.name) ?? request.params.name;
    const result = await runtime.invoke(capabilityId, request.params.arguments ?? {}, {
      actor,
      context,
      surface: "mcp",
      ...(extra.signal ? { signal: extra.signal } : {}),
    });
    return toCallToolResult(translateResult(result, approvalUx));
  });

  return {
    server,
    connect: async (transport) => {
      // Set before connect: the SDK chains whatever handler it finds rather
      // than replacing it, so this runs in addition to its own teardown.
      const priorOnClose = transport.onclose;
      transport.onclose = () => {
        identities.clear();
        priorOnClose?.();
      };
      await server.connect(transport);
    },
  };
}

/**
 * `AuthInfo.expiresAt` is seconds since the epoch (MCP SDK). Absent means the
 * transport gave no expiry to enforce — that is the app's `createContext` call
 * to make, not this adapter's.
 */
function isExpired(authInfo: AuthInfo | undefined): boolean {
  return authInfo?.expiresAt !== undefined && authInfo.expiresAt * 1000 <= Date.now();
}

type MCPEnvelope =
  | { status: "ok"; data: unknown }
  | {
      status: "approval-required";
      approvalId: string;
      message: string;
      /** ISO 8601 — when the pending decision dies. */
      expiresAt: string;
      /** Locator for the app's authenticated approver UI (`approvals.url`). */
      url?: string;
    }
  | {
      status: "error";
      error: { code: string; message: string; retryable: boolean; details?: unknown };
    };

/** What the approval-required message weaves in, resolved once at startup. */
type ApprovalUx = {
  url?: (record: ApprovalRecord) => string | undefined;
  resumeToolName?: string;
};

/**
 * Same envelope as the AI SDK adapter, plus isError at the protocol level and
 * two MCP-only fields on approval-required (`expiresAt`; `url` when
 * `approvals.url` is configured).
 */
function translateResult(result: ExecutionResult<unknown>, ux: ApprovalUx = {}): MCPEnvelope {
  switch (result.status) {
    case "completed":
      return { status: "ok", data: result.output };
    case "approval-required": {
      const record = result.approval;
      const url = ux.url?.(record);
      const parts = [
        record.reasons.length > 0
          ? `Awaiting approval: ${record.reasons.join("; ")}.`
          : "Awaiting approval.",
      ];
      if (url !== undefined) {
        parts.push(
          `Share this link with the user so an authorized human can review and decide: ${url}`,
        );
      }
      if (ux.resumeToolName !== undefined) {
        parts.push(`Once approved, call ${ux.resumeToolName} with this approvalId to execute.`);
      }
      return {
        status: "approval-required",
        approvalId: record.id,
        message: parts.join(" "),
        expiresAt: record.expiresAt.toISOString(),
        ...(url !== undefined ? { url } : {}),
      };
    }
    case "failed":
    case "cancelled":
      return { status: "error", error: serializeError(result.error) };
  }
}

function toCallToolResult(envelope: MCPEnvelope): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    isError: envelope.status === "error",
  };
}

const DEFAULT_RESUME_TOOL_NAME = "approvals_resume";

const DEFAULT_RESUME_TOOL_DESCRIPTION =
  "Execute an operation that a human has already approved. Pass the approvalId from an earlier " +
  "approval-required tool result. This tool cannot approve or reject anything — decisions are " +
  "made by humans outside this connection. It runs the approved operation exactly once, as the " +
  "original requester, and fails while the decision is pending or after rejection, expiry, or " +
  "prior use.";

const RESUME_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    approvalId: {
      type: "string",
      description: "The approvalId from an approval-required result in this session.",
    },
  },
  required: ["approvalId"],
  additionalProperties: false,
} as const;

function resolveResumeTool(
  option: boolean | { name?: string; description?: string } | undefined,
): { name: string; description: string } | undefined {
  if (option === undefined || option === false) return undefined;
  const config = option === true ? {} : option;
  return {
    name: config.name ?? DEFAULT_RESUME_TOOL_NAME,
    description: config.description ?? DEFAULT_RESUME_TOOL_DESCRIPTION,
  };
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
