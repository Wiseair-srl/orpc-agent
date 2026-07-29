import type { LanguageModelV2, LanguageModelV2Content } from "@ai-sdk/provider";

/**
 * A deterministic LanguageModelV2 that plays a fixed conversation — Mastra
 * accepts any AI SDK model instance, so tests and the demo exercise the real
 * Agent loop (planning → tool calls → reply) without a provider or key. This
 * example runs on `ai@^5`, hence the v2 provider spec.
 */

export type ScriptStep = { toolName: string; args: unknown } | { text: string };

export function scriptedModel(steps: ScriptStep[]): LanguageModelV2 {
  let index = 0;
  return {
    specificationVersion: "v2",
    provider: "scripted",
    modelId: "task-board-script",
    supportedUrls: {},
    async doGenerate() {
      const step = steps[index];
      if (!step) throw new Error("script exhausted");
      index += 1;
      const content: LanguageModelV2Content[] =
        "text" in step
          ? [{ type: "text", text: step.text }]
          : [
              {
                type: "tool-call",
                toolCallId: `call_${index}`,
                toolName: step.toolName,
                input: JSON.stringify(step.args),
              },
            ];
      return {
        content,
        finishReason: "text" in step ? ("stop" as const) : ("tool-calls" as const),
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
    async doStream() {
      throw new Error("the scripted model does not stream");
    },
  };
}
