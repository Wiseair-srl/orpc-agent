import { allow, definePolicy, requireApproval } from "@orpc-agent/core";

/**
 * Conditional approval expressed as a policy — the static
 * `approval: { required: true }` gate on `tasks.delete` covers the
 * unconditional case; this covers the input-dependent one.
 */
export const urgentNeedsApproval = definePolicy("urgent-needs-approval", ({ capability, input }) => {
  if (capability.id !== "tasks.create") return allow();
  const { priority } = input as { priority: string };
  if (priority === "urgent") {
    return requireApproval({
      reason: "Urgent tasks page the on-call rotation",
      approvalType: "human-confirmation",
    });
  }
  return allow();
});
