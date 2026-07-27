import type { AgentAuditEvent, AgentAuditEventType, AuditSink } from "../src/events";
import type { Actor } from "../src/types";

export type CapturedEvents = {
  sink: AuditSink;
  events(): AgentAuditEvent[];
  types(): AgentAuditEventType[];
  ofType<T extends AgentAuditEventType>(type: T): Extract<AgentAuditEvent, { type: T }>[];
  clear(): void;
};

export function capturedEvents(): CapturedEvents {
  const events: AgentAuditEvent[] = [];
  return {
    sink: (event) => {
      events.push(event);
    },
    events: () => [...events],
    types: () => events.map((e) => e.type),
    ofType: <T extends AgentAuditEventType>(type: T) =>
      events.filter((e) => e.type === type) as Extract<AgentAuditEvent, { type: T }>[],
    clear: () => {
      events.length = 0;
    },
  };
}

export function mutableClock(startIso = "2026-07-27T10:00:00.000Z") {
  let current = new Date(startIso).getTime();
  return {
    now: () => new Date(current),
    advance(ms: number) {
      current += ms;
    },
  };
}

export const dana: Actor = {
  id: "u_dana",
  kind: "user",
  attributes: { orgId: "org_1", permissions: ["orders:refund"] },
};

export const priya: Actor = { id: "u_priya", kind: "user" };
