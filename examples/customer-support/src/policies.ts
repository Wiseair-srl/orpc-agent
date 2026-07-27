import { allow, definePolicy, deny, requireApproval } from "@orpc-agent/core";
import type { AppContext } from "./context";

export const refundLimit = definePolicy("refund-limit", ({ capability, input }) => {
  if (capability.id !== "orders.refund") return allow();
  const { amount } = input as { amount: number };
  if (amount >= 5000) return deny("REFUND_TOO_LARGE", "Refunds of $5000 or more cannot be issued by agents.");
  if (amount > 500) return requireApproval({ reason: `Refund of $${amount} exceeds $500`, approvalType: "manager" });
  return allow();
});

export const orgIsolation = definePolicy("org-isolation", ({ actor, context }) =>
  actor.attributes?.orgId === (context as AppContext).organizationId
    ? allow()
    : deny("ORG_MISMATCH", "Operation not available for this organization."));

/**
 * Belt-and-suspenders: writes aren't exposed to mcp anyway (SI-1); this
 * guards against a future exposure mistake (defense in depth, cheap).
 */
export const mcpReadOnly = definePolicy("mcp-read-only", ({ surface, capability }) =>
  surface === "mcp" && !["read", "none"].includes(capability.meta.sideEffect)
    ? deny("MCP_READ_ONLY", "Write operations are not available over MCP.")
    : allow());
