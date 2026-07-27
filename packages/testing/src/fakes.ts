import type {
  Actor,
  AgentAuditEvent,
  AgentAuditEventType,
  AuditSink,
} from "@orpc-agent/core";

/** Well-formed Actor with stable defaults. */
export function fakeActor(partial?: Partial<Actor>): Actor {
  return { id: "test-user", kind: "user", ...partial };
}

export type TestClock = {
  now(): Date;
  /** Advance by milliseconds or a duration string ("15m", "30s", "1h", "2d", "500ms"). */
  advance(amount: number | string): void;
  set(iso: string): void;
};

export function testClock(startIso = "2026-01-01T00:00:00.000Z"): TestClock {
  let current = new Date(startIso).getTime();
  if (Number.isNaN(current)) {
    throw new TypeError(`testClock: invalid start "${startIso}"`);
  }
  return {
    now: () => new Date(current),
    advance(amount) {
      current += parseDuration(amount);
    },
    set(iso) {
      const next = new Date(iso).getTime();
      if (Number.isNaN(next)) throw new TypeError(`testClock.set: invalid date "${iso}"`);
      current = next;
    },
  };
}

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseDuration(amount: number | string): number {
  if (typeof amount === "number") {
    if (!Number.isFinite(amount)) throw new TypeError("advance: amount must be finite");
    return amount;
  }
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(amount.trim());
  if (!match) {
    throw new TypeError(
      `advance: cannot parse duration "${amount}" (expected e.g. "500ms", "30s", "15m", "2h", "1d")`,
    );
  }
  return Number(match[1]) * DURATION_UNITS[match[2]!]!;
}

export type CapturedAudit = AuditSink & {
  events(): AgentAuditEvent[];
  types(): AgentAuditEventType[];
  ofType<T extends AgentAuditEventType>(type: T): Extract<AgentAuditEvent, { type: T }>[];
  clear(): void;
};

/**
 * Sink + query API. Doubles as the reference AuditSink implementation:
 * synchronous, ordered, in-memory.
 */
export function capturedAudit(): CapturedAudit {
  const store: AgentAuditEvent[] = [];
  const sink = ((event: AgentAuditEvent) => {
    store.push(event);
  }) as CapturedAudit;
  sink.events = () => [...store];
  sink.types = () => store.map((e) => e.type);
  sink.ofType = <T extends AgentAuditEventType>(type: T) =>
    store.filter((e) => e.type === type) as Extract<AgentAuditEvent, { type: T }>[];
  sink.clear = () => {
    store.length = 0;
  };
  return sink;
}
