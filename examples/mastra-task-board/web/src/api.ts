import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "../../src/capabilities";

/**
 * Surface 1 — the board UI talks to the procedures as plain, fully typed
 * oRPC. `AppRouter` is a type-only import: the server's router shape flows
 * end-to-end, no codegen.
 */
const link = new RPCLink({ url: `${location.origin}/rpc` });
export const client: RouterClient<AppRouter> = createORPCClient(link);

export type Task = Awaited<ReturnType<typeof client.tasks.list>>["tasks"][number];

// ---------------------------------------------------------------------------
// Surface 2 — the agent endpoints (JSON over fetch)
// ---------------------------------------------------------------------------

export type Health = { ok: boolean; aiEnabled: boolean; model: string | null };

export type CapabilityCard = {
  id: string;
  description: string;
  sideEffect: string;
  risk: string;
  requiresApproval: boolean;
};

export type ToolEnvelope =
  | { status: "ok"; data: unknown }
  | { status: "approval-required"; approvalId: string; message: string }
  | { status: "error"; error: { code: string; message: string; retryable: boolean } };

export type ToolEvent = { toolName: string; args: unknown; result: ToolEnvelope };

export type ApprovalCard = {
  id: string;
  capabilityId: string;
  reasons: string[];
  input: unknown;
  taskTitle: string | null;
  requestedAt: string;
  expiresAt: string;
};

export type Resolution =
  | { status: "completed"; output: unknown }
  | { status: "rejected" }
  | { status: "approval-required"; approvalId: string }
  | { status: "failed" | "cancelled"; error: { code: string; message: string } };

export type AuditRow = {
  at: string;
  type: string;
  capabilityId: string | null;
  surface: string;
  actor: string;
  data: Record<string, unknown>;
};

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type ChatResponse = {
  text: string;
  toolEvents: ToolEvent[];
  pendingApprovals: ApprovalCard[];
};

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const body = (await response.json().catch(() => null)) as T & { error?: string };
  if (!response.ok) {
    throw new Error(body?.error ?? `${path} failed (${response.status})`);
  }
  return body;
}

export const api = {
  health: () => json<Health>("/api/health"),
  capabilities: () => json<CapabilityCard[]>("/api/agent/capabilities"),
  chat: (messages: ChatMessage[]) =>
    json<ChatResponse>("/api/chat", { method: "POST", body: JSON.stringify({ messages }) }),
  approvals: () => json<ApprovalCard[]>("/api/approvals"),
  decide: (id: string, approved: boolean) =>
    json<{ resolution: Resolution }>(`/api/approvals/${id}`, {
      method: "POST",
      body: JSON.stringify({ approved }),
    }),
  audit: () => json<AuditRow[]>("/api/audit"),
};
