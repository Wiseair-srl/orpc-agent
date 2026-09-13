import { jsonSchema, tool, type Tool, type ToolSet } from "ai";
import type { CapabilityClient, CapabilityOutcome, PortableCapabilityDescriptor } from "@orpc-agent/core/client";
import { defaultToolName } from "@orpc-agent/core";
import type {
  Actor,
  AgentRuntime,
  CapabilityDescriptor,
  CapabilityError,
  DescribeScope,
  ExecutionResult,
} from "@orpc-agent/core";

/**
 * Adapter: Vercel AI SDK, `ai@^5 || ^6`. Surface id: "aiSdk". One capability exposed to
 * aiSdk ⇢ one tool; discovery, validation, policy, approval, and execution
 * all happen in the runtime (docs/adapters/ai-sdk.md).
 */

export type AISDKToolsOptions<TContext = unknown> = {
  /** Authenticated identity, never model-derived (SI-3). Bound per tool set. */
  actor: Actor;
  /** The app's oRPC context for this request. */
  context: TContext;
  /**
   * Narrows what gets DISCOVERED — forwarded verbatim to `runtime.describe`,
   * so the discovery policies of everything outside it never run. Not
   * authorization (SI-2); `filter` still shapes what survives.
   */
  scope?: DescribeScope;
  /** Conversation-shaping only, not authorization (SI-2). */
  filter?: (descriptor: CapabilityDescriptor) => boolean;
  /** Replaces the default "." → "_" mapping. Per-capability meta overrides win. */
  toolNaming?: (capabilityId: string) => string;
  /** Composed into every invocation (in addition to per-call abort from the loop). */
  signal?: AbortSignal;
};

export type AISDKToolResult =
  | { status: "ok"; data: unknown }
  | { status: "approval-required"; approvalId: string; message: string; invocationId?: string }
  | {
      status: "error";
      error: { code: string; message: string; retryable: boolean; details?: unknown };
    };

/**
 * Builds AI SDK tools from the runtime's capabilities exposed to "aiSdk",
 * already exposure- and discovery-policy-filtered for this actor. Build PER
 * REQUEST; caching a tool set across users leaks visibility decisions.
 */
export type RemoteAISDKToolResult = AISDKToolResult | { status: "outcome-unknown"; invocationId: string; message: string };

export type RemoteAISDKToolsOptions = {
  scope?: DescribeScope;
  filter?: (descriptor: PortableCapabilityDescriptor) => boolean;
  signal?: AbortSignal;
  correlationId?: string;
  /** Persist the returned operation ID before dispatch; model call IDs alone are not replay identity. */
  invocationId(request: { capabilityId: string; input: unknown; toolCallId: string }): string | Promise<string>;
};

export function toAISDKTools<TContext = unknown>(runtime: AgentRuntime<TContext>, options: AISDKToolsOptions<TContext>): Promise<ToolSet>;
export function toAISDKTools(client: CapabilityClient, options: RemoteAISDKToolsOptions): Promise<ToolSet>;
export async function toAISDKTools<TContext = unknown>(runtime: AgentRuntime<TContext> | CapabilityClient, options: AISDKToolsOptions<TContext> | RemoteAISDKToolsOptions): Promise<ToolSet> {
  if (!("registry" in runtime)) return remoteTools(runtime, options as RemoteAISDKToolsOptions);
  return localTools(runtime, options as AISDKToolsOptions<TContext>);
}

async function localTools<TContext>(runtime: AgentRuntime<TContext>, options: AISDKToolsOptions<TContext>): Promise<ToolSet> {
  if (!options || !options.actor) {
    throw new TypeError("toAISDKTools: options with actor and context are required");
  }

  const descriptors = await runtime.describe("aiSdk", {
    actor: options.actor,
    context: options.context,
    ...(options.scope ? { scope: options.scope } : {}),
  });
  const filtered = options.filter ? descriptors.filter(options.filter) : descriptors;

  const tools: Record<string, Tool> = {};
  const names = new Map<string, string>();

  for (const descriptor of filtered) {
    const meta = runtime.registry.get(descriptor.id)?.meta;
    const toolName =
      meta?.adapters?.aiSdk?.toolName ??
      options.toolNaming?.(descriptor.id) ??
      defaultToolName(descriptor.id);

    const existing = names.get(toolName);
    if (existing !== undefined) {
      throw new Error(
        `toAISDKTools: tool name collision — "${existing}" and "${descriptor.id}" both map to "${toolName}"`,
      );
    }
    names.set(toolName, descriptor.id);

    const description =
      descriptor.description + (descriptor.requiresApproval ? " Requires approval." : "");

    tools[toolName] = tool({
      description,
      inputSchema: jsonSchema<Record<string, unknown>>(
        descriptor.inputSchema as Parameters<typeof jsonSchema>[0] as never,
      ),
      // Raw arguments are forwarded — the runtime is the single validation
      // authority (pipeline stage 5); the adapter never pre-validates.
      execute: async (args, executeOptions): Promise<AISDKToolResult> => {
        const signal = composeSignals(options.signal, executeOptions?.abortSignal);
        const result = await runtime.invoke(descriptor.id, args, {
          actor: options.actor,
          context: options.context,
          surface: "aiSdk",
          ...(signal ? { signal } : {}),
        });
        return translateResult(result);
      },
    });
  }

  return tools;
}

function composeSignals(
  a: AbortSignal | undefined,
  b: AbortSignal | undefined,
): AbortSignal | undefined {
  if (a && b) return AbortSignal.any([a, b]);
  return a ?? b;
}

/**
 * Deterministic envelope translation — return, don't throw: the model stays
 * in the loop with typed, uniform feedback (docs/adapters/ai-sdk.md#result-shape).
 */
function translateResult(result: ExecutionResult<unknown>): AISDKToolResult {
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
function serializeError(error: CapabilityError): AISDKToolResult extends never
  ? never
  : { code: string; message: string; retryable: boolean; details?: unknown } {
  if (!error.exposeToModel) {
    return { code: "INTERNAL_ERROR", message: "The operation failed.", retryable: false };
  }
  return {
    code: error.code,
    message: error.publicMessage,
    retryable: error.retryable,
    // details only for INPUT_INVALID — data the model itself produced.
    ...(error.code === "INPUT_INVALID" && error.details !== undefined
      ? { details: error.details }
      : {}),
  };
}

async function remoteTools(client: CapabilityClient, options: RemoteAISDKToolsOptions): Promise<ToolSet> {
  if (typeof options?.invocationId !== "function") throw new TypeError("Remote AI SDK tools require a durable invocationId allocator");
  const descriptors = await client.describe({ scope: options.scope });
  const tools: ToolSet = Object.create(null);
  for (const descriptor of descriptors) {
    if (descriptor.discovery === "contextual" || (options.filter && !options.filter(descriptor))) continue;
    const name = descriptor.toolNames.aiSdk;
    if (Object.hasOwn(tools, name)) throw new Error(`toAISDKTools: tool name collision for "${name}"`);
    tools[name] = tool({
      description: descriptor.description + (descriptor.requiresApproval ? " Requires approval." : ""),
      inputSchema: jsonSchema<Record<string, unknown>>(descriptor.inputSchema as never),
      execute: async (input, executeOptions): Promise<RemoteAISDKToolResult> => {
        const invocationId = await options.invocationId({ capabilityId: descriptor.id, input, toolCallId: executeOptions.toolCallId });
        const result = await client.invoke(descriptor.id, input, {
          invocationId, correlationId: options.correlationId, contractDigest: descriptor.contractDigest,
          signal: composeSignals(options.signal, executeOptions.abortSignal),
        });
        return translateRemoteResult(result);
      },
    });
  }
  return tools;
}
function translateRemoteResult(result: CapabilityOutcome): RemoteAISDKToolResult {
  switch (result.status) {
    case "completed": return { status: "ok", data: result.output };
    case "approval-required": return { status: "approval-required", invocationId: result.invocationId, approvalId: result.approval.id, message: "Awaiting approval." };
    case "failed": case "cancelled": return { status: "error", error: result.error };
    case "outcome-unknown": return { status: "outcome-unknown", invocationId: result.invocationId, message: "The operation outcome is unknown. Reconcile this invocation before issuing another action." };
  }
}
