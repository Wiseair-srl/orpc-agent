/**
 * Base classification and identity types shared across the capability model.
 */

export type ExposureSurface = "direct" | "aiSdk" | "mcp" | "workflow" | "test";

export const EXPOSURE_SURFACES: readonly ExposureSurface[] = [
  "direct",
  "aiSdk",
  "mcp",
  "workflow",
  "test",
];

export type SideEffect = "none" | "read" | "write" | "destructive" | "external";

export const SIDE_EFFECTS: readonly SideEffect[] = [
  "none",
  "read",
  "write",
  "destructive",
  "external",
];

export type RiskLevel = "low" | "medium" | "high" | "critical";

export const RISK_LEVELS: readonly RiskLevel[] = ["low", "medium", "high", "critical"];

/**
 * The authenticated requesting entity. Never the model (SI-3): adapters build
 * this from transport credentials; nothing model-authored may change it.
 */
export type Actor = {
  id: string;
  kind: "user" | "service" | "automation" | "anonymous";
  displayName?: string;
  /** App-defined (roles, permissions, org). The runtime never interprets it. */
  attributes?: Record<string, unknown>;
};

/**
 * Injected as `context.agent` at pipeline stage 11 so middleware and handlers
 * can react to agent-originated calls. `undefined` on non-agent invocations.
 */
export type AgentInvocationInfo = {
  executionId: string;
  capabilityId: string;
  surface: ExposureSurface;
  actor: Actor;
  approval?: { id: string; approver: Actor };
  correlationId?: string;
  /** Stable per execution (survives runtime retries). */
  idempotencyKey: string;
};

export function isWellFormedActor(value: unknown): value is Actor {
  if (typeof value !== "object" || value === null) return false;
  const actor = value as Record<string, unknown>;
  return (
    typeof actor.id === "string" &&
    actor.id.length > 0 &&
    (actor.kind === "user" ||
      actor.kind === "service" ||
      actor.kind === "automation" ||
      actor.kind === "anonymous")
  );
}
