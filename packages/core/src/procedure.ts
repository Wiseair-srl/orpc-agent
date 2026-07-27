import type { Builder } from "@orpc/server";
import type { AgentInvocationInfo } from "./types";
import type { AgentMeta } from "./meta";

type AgentContextExtension = { agent?: AgentInvocationInfo };

/**
 * Types an oRPC builder for agent use: the meta type gains
 * `{ agent?: AgentMeta }` and the context type gains
 * `{ agent?: AgentInvocationInfo }`. Creates no wrapper object and changes no
 * runtime behavior — the return value is the same oRPC builder, more precisely
 * typed (ADR-001).
 */
export function agentProcedure<
  B extends Builder<any, any, any, any, any, any>,
>(
  builder: B,
): B extends Builder<
  infer TInitialContext,
  infer TCurrentContext,
  infer TInputSchema,
  infer TOutputSchema,
  infer TErrorMap,
  infer TMeta
>
  ? Builder<
      TInitialContext & AgentContextExtension,
      TCurrentContext & AgentContextExtension,
      TInputSchema,
      TOutputSchema,
      TErrorMap,
      TMeta & { agent?: AgentMeta }
    >
  : never {
  // Type-level refinement only; the builder is returned unchanged.
  return builder as never;
}
