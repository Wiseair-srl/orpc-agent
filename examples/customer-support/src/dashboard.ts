import { ORPCError } from "@orpc/server";
import type { Session } from "./context";
import type { App } from "./app";

/**
 * The approvals dashboard "routes": list pending, decide, resume. Gate the
 * decide endpoint like any privileged operation — who may approve is the
 * application's authorization question; the runtime enforces the structural
 * rules (pending-only, expiry, approver ≠ requester).
 */

export async function listPendingApprovals(app: App, session: Session) {
  requirePermission(session, "approvals:decide");
  const pending = (await app.runtime.approvals.list?.({ status: "pending" })) ?? [];
  return pending.map((record) => {
    const meta = app.runtime.registry.get(record.capabilityId)?.meta;
    return {
      id: record.id,
      capabilityId: record.capabilityId,
      requestedBy: record.actor.displayName ?? record.actor.id,
      reasons: record.reasons,
      expiresAt: record.expiresAt,
      // Approvers see the redacted display input; the hash binds the full one.
      displayInput: meta?.redact?.approvalInput?.(record.input) ?? record.input,
    };
  });
}

export async function decideApproval(
  app: App,
  session: Session,
  approvalId: string,
  decision: { approved: boolean; comment?: string },
) {
  requirePermission(session, "approvals:decide");
  return app.runtime.approvals.decide(approvalId, {
    status: decision.approved ? "approved" : "rejected",
    approver: app.actorFrom(session),
    ...(decision.comment !== undefined ? { comment: decision.comment } : {}),
  });
}

/** The dashboard worker: deciding records intent; executing is separate. */
export async function resumeApproved(app: App, approvalId: string, session: Session) {
  return app.runtime.resume(approvalId, { context: app.contextFor(session) });
}

function requirePermission(session: Session, permission: string) {
  if (!session.permissions.includes(permission)) {
    throw new ORPCError("FORBIDDEN", { message: `Missing permission: ${permission}` });
  }
}
