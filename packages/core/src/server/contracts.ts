import type { AgentGovernance } from "../governance";
import { defaultToolName } from "../registry";
import { hashInput } from "../canonical";
import { toJsonSchema } from "../schema/index";
import type { PortableCapabilityDescriptor } from "../client/index";

/** Static artifact only: never an authorization decision. revision must change with policies/handlers. */
export async function exportCapabilityContract(governance: AgentGovernance, revision: string): Promise<PortableCapabilityDescriptor[]> {
  if (!revision.trim()) throw new TypeError("A non-empty deployment revision is required");
  return Promise.all(governance.registry.capabilities().map(async (capability) => {
    const descriptor = {
      version: 1 as const,
      id: capability.id,
      path: [...capability.path],
      description: capability.meta.description,
      inputSchema: capability.inputSchema ? structuredClone(toJsonSchema(capability.inputSchema)) : { type: "object" },
      sideEffect: capability.meta.sideEffect,
      risk: capability.meta.risk,
      tags: [...(capability.meta.tags ?? [])],
      discovery: capability.meta.discovery ?? "discoverable",
      requiresApproval: capability.meta.approval?.required === true,
      toolNames: {
        aiSdk: capability.meta.adapters?.aiSdk?.toolName ?? defaultToolName(capability.id),
        mcp: capability.meta.adapters?.mcp?.toolName ?? defaultToolName(capability.id),
      },
    };
    return { ...descriptor, contractDigest: await hashInput({ descriptor, revision, expose: capability.meta.expose, policies: governance.manifest }) };
  }));
}
