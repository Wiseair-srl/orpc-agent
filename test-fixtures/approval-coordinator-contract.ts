import { describe, expect, test } from "vitest";

/**
 * Behavioral contract for `ApprovalCoordinator` implementations
 * (docs/guides/human-approval.md#production-coordinator; threat T8), as a
 * describe-block factory. Consumed by @orpc-agent/core (in-memory coordinator)
 * and @orpc-agent/postgres — one suite, every implementation.
 *
 * The types below structurally mirror @orpc-agent/core's approvals/types.
 * They are deliberately local: this fixture must never force a build of core
 * to run core's own tests. Drift against the real types surfaces as an
 * assignability error at each consumer's call site.
 */

export type ContractActor = {
  id: string;
  kind: "user" | "service" | "automation" | "anonymous";
  displayName?: string;
  attributes?: Record<string, unknown>;
};

export type ContractApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "cancelled"
  | "consumed";

export type ContractApprovalRequest = {
  id: string;
  capabilityId: string;
  surface: "direct" | "aiSdk" | "mcp" | "workflow" | "test";
  actor: ContractActor;
  input: unknown;
  inputHash: string;
  reasons: string[];
  types: string[];
  risk: "low" | "medium" | "high" | "critical";
  sideEffect: "none" | "read" | "write" | "destructive" | "external";
  requestedAt: Date;
  expiresAt: Date;
};

export type ContractApprovalDecision = {
  status: "approved" | "rejected";
  approver: ContractActor;
  comment?: string;
};

export type ContractApprovalRecord = ContractApprovalRequest & {
  status: ContractApprovalStatus;
  decision?: ContractApprovalDecision & { decidedAt: Date };
  consumedByExecutionId?: string;
};

export type ContractCoordinator = {
  create(request: ContractApprovalRequest): Promise<ContractApprovalRecord>;
  get(id: string): Promise<ContractApprovalRecord | null>;
  decide(id: string, decision: ContractApprovalDecision): Promise<ContractApprovalRecord>;
  markConsumed(id: string, executionId: string): Promise<ContractApprovalRecord>;
  list?(filter?: {
    status?: ContractApprovalStatus;
    capabilityId?: string;
    actorId?: string;
  }): Promise<ContractApprovalRecord[]>;
};

export function contractClock(startIso = "2026-07-27T10:00:00.000Z") {
  let current = new Date(startIso).getTime();
  return {
    now: () => new Date(current),
    advance(ms: number) {
      current += ms;
    },
  };
}

const requester: ContractActor = { id: "u_dana", kind: "user" };
const approver: ContractActor = { id: "u_priya", kind: "user" };

const FIFTEEN_MINUTES = 900_000;
let sequence = 0;

export function makeApprovalRequest(
  now: () => Date,
  overrides?: Partial<ContractApprovalRequest>,
): ContractApprovalRequest {
  sequence += 1;
  return {
    id: `apr_${sequence}`,
    capabilityId: "orders.refund",
    surface: "aiSdk",
    actor: requester,
    input: { orderId: "ord_42", amount: 649, reason: "damaged item" },
    inputHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    reasons: ["Refund of $649 exceeds $500"],
    types: ["manager"],
    risk: "high",
    sideEffect: "write",
    requestedAt: now(),
    expiresAt: new Date(now().getTime() + FIFTEEN_MINUTES),
    ...overrides,
  };
}

export function describeApprovalCoordinatorContract(
  name: string,
  makeCoordinator: (now: () => Date) => Promise<ContractCoordinator>,
): void {
  describe(`approval coordinator contract: ${name}`, () => {
    async function setup() {
      const clock = contractClock();
      const coordinator = await makeCoordinator(clock.now);
      return { clock, coordinator };
    }

    test("create stores a pending record and returns it in full", async () => {
      const { clock, coordinator } = await setup();
      const request = makeApprovalRequest(clock.now);
      const record = await coordinator.create(request);

      expect(record.status).toBe("pending");
      expect(record.id).toBe(request.id);
      expect(record.capabilityId).toBe("orders.refund");
      expect(record.surface).toBe("aiSdk");
      expect(record.actor).toEqual(requester);
      expect(record.input).toEqual(request.input);
      expect(record.inputHash).toBe(request.inputHash);
      expect(record.reasons).toEqual(request.reasons);
      expect(record.types).toEqual(request.types);
      expect(record.risk).toBe("high");
      expect(record.sideEffect).toBe("write");
      expect(record.requestedAt).toBeInstanceOf(Date);
      expect(record.requestedAt.getTime()).toBe(request.requestedAt.getTime());
      expect(record.expiresAt.getTime()).toBe(request.expiresAt.getTime());
      expect(record.decision).toBeUndefined();
      expect(record.consumedByExecutionId).toBeUndefined();
    });

    test("create refuses a duplicate id", async () => {
      const { clock, coordinator } = await setup();
      const request = makeApprovalRequest(clock.now);
      await coordinator.create(request);
      await expect(coordinator.create(request)).rejects.toThrowError(/already exists/);
    });

    test("get of an unknown id returns null; decide and markConsumed throw", async () => {
      const { coordinator } = await setup();
      expect(await coordinator.get("apr_nope")).toBeNull();
      await expect(
        coordinator.decide("apr_nope", { status: "approved", approver }),
      ).rejects.toThrowError(/was not found/);
      await expect(coordinator.markConsumed("apr_nope", "exe_1")).rejects.toThrowError(
        /was not found/,
      );
    });

    test("returned records are detached copies of the stored state", async () => {
      const { clock, coordinator } = await setup();
      const request = makeApprovalRequest(clock.now);
      const created = await coordinator.create(request);
      created.status = "approved";
      const read = await coordinator.get(request.id);
      expect(read!.status).toBe("pending");
      read!.status = "consumed";
      expect((await coordinator.get(request.id))!.status).toBe("pending");
    });

    test("decide approves with approver, comment, and decidedAt from the clock", async () => {
      const { clock, coordinator } = await setup();
      const request = makeApprovalRequest(clock.now);
      await coordinator.create(request);
      clock.advance(60_000);

      const decided = await coordinator.decide(request.id, {
        status: "approved",
        approver,
        comment: "Verified with customer",
      });
      expect(decided.status).toBe("approved");
      expect(decided.decision?.status).toBe("approved");
      expect(decided.decision?.approver).toEqual(approver);
      expect(decided.decision?.comment).toBe("Verified with customer");
      expect(decided.decision?.decidedAt.getTime()).toBe(clock.now().getTime());

      const read = await coordinator.get(request.id);
      expect(read!.status).toBe("approved");
      expect(read!.decision?.approver.id).toBe("u_priya");
    });

    test("decide records a rejection", async () => {
      const { clock, coordinator } = await setup();
      const request = makeApprovalRequest(clock.now);
      await coordinator.create(request);
      const decided = await coordinator.decide(request.id, {
        status: "rejected",
        approver,
        comment: "Not warranted",
      });
      expect(decided.status).toBe("rejected");
      expect((await coordinator.get(request.id))!.status).toBe("rejected");
    });

    test("decide validates the decision status and the approver", async () => {
      const { clock, coordinator } = await setup();
      const request = makeApprovalRequest(clock.now);
      await coordinator.create(request);
      await expect(
        coordinator.decide(request.id, {
          status: "maybe" as never,
          approver,
        }),
      ).rejects.toThrowError(/Invalid decision status/);
      await expect(
        coordinator.decide(request.id, {
          status: "approved",
          approver: { id: "", kind: "user" },
        }),
      ).rejects.toThrowError(/well-formed/);
      // Guards fire before any state change.
      expect((await coordinator.get(request.id))!.status).toBe("pending");
    });

    test("decide refuses a record that is no longer pending", async () => {
      const { clock, coordinator } = await setup();
      const request = makeApprovalRequest(clock.now);
      await coordinator.create(request);
      await coordinator.decide(request.id, { status: "approved", approver });
      await expect(
        coordinator.decide(request.id, { status: "rejected", approver }),
      ).rejects.toThrowError(/not pending/);
    });

    test("decide refuses an expired pending record", async () => {
      const { clock, coordinator } = await setup();
      const request = makeApprovalRequest(clock.now);
      await coordinator.create(request);
      clock.advance(FIFTEEN_MINUTES + 1);
      await expect(
        coordinator.decide(request.id, { status: "approved", approver }),
      ).rejects.toThrowError(/not pending|expired/);
    });

    test("lazy expiry: a pending record reads as expired after its deadline", async () => {
      const { clock, coordinator } = await setup();
      const request = makeApprovalRequest(clock.now);
      await coordinator.create(request);

      clock.advance(FIFTEEN_MINUTES - 1);
      expect((await coordinator.get(request.id))!.status).toBe("pending");

      clock.advance(2);
      expect((await coordinator.get(request.id))!.status).toBe("expired");
      const expired = await coordinator.list!({ status: "expired" });
      expect(expired.map((r) => r.id)).toContain(request.id);
      const pending = await coordinator.list!({ status: "pending" });
      expect(pending.map((r) => r.id)).not.toContain(request.id);
    });

    test("expiry applies only to pending records; the runtime owns post-approval expiry", async () => {
      const { clock, coordinator } = await setup();
      const request = makeApprovalRequest(clock.now);
      await coordinator.create(request);
      await coordinator.decide(request.id, { status: "approved", approver });

      clock.advance(FIFTEEN_MINUTES + 1);
      // The coordinator keeps the decided state; APPROVAL_EXPIRED at resume is
      // the pipeline's check, not the store's.
      expect((await coordinator.get(request.id))!.status).toBe("approved");
      const consumed = await coordinator.markConsumed(request.id, "exe_late");
      expect(consumed.status).toBe("consumed");
    });

    test("markConsumed consumes an approved record exactly once (T8)", async () => {
      const { clock, coordinator } = await setup();
      const request = makeApprovalRequest(clock.now);
      await coordinator.create(request);
      await coordinator.decide(request.id, { status: "approved", approver });

      const consumed = await coordinator.markConsumed(request.id, "exe_1");
      expect(consumed.status).toBe("consumed");
      expect(consumed.consumedByExecutionId).toBe("exe_1");

      await expect(coordinator.markConsumed(request.id, "exe_2")).rejects.toThrowError(
        /cannot be consumed/,
      );
      expect((await coordinator.get(request.id))!.consumedByExecutionId).toBe("exe_1");
    });

    test("markConsumed refuses records that were never approved", async () => {
      const { clock, coordinator } = await setup();
      const pending = makeApprovalRequest(clock.now);
      await coordinator.create(pending);
      await expect(coordinator.markConsumed(pending.id, "exe_x")).rejects.toThrowError(
        /cannot be consumed/,
      );

      const rejected = makeApprovalRequest(clock.now);
      await coordinator.create(rejected);
      await coordinator.decide(rejected.id, { status: "rejected", approver });
      await expect(coordinator.markConsumed(rejected.id, "exe_x")).rejects.toThrowError(
        /cannot be consumed/,
      );
    });

    test("list filters by status, capabilityId, and actorId — alone and composed", async () => {
      const { clock, coordinator } = await setup();
      const first = makeApprovalRequest(clock.now);
      const second = makeApprovalRequest(clock.now, {
        capabilityId: "orders.cancel",
        actor: { id: "u_omar", kind: "user" },
      });
      await coordinator.create(first);
      await coordinator.create(second);
      await coordinator.decide(second.id, { status: "rejected", approver });

      expect(await coordinator.list!()).toHaveLength(2);
      expect(await coordinator.list!({ status: "pending" })).toHaveLength(1);
      expect(await coordinator.list!({ actorId: "u_dana" })).toHaveLength(1);
      expect(await coordinator.list!({ capabilityId: "orders.cancel" })).toHaveLength(1);
      const composed = await coordinator.list!({
        capabilityId: "orders.cancel",
        status: "rejected",
        actorId: "u_omar",
      });
      expect(composed.map((r) => r.id)).toEqual([second.id]);
      expect(await coordinator.list!({ status: "consumed" })).toHaveLength(0);
    });

    test("concurrent decide: exactly one settles fulfilled", async () => {
      const { clock, coordinator } = await setup();
      const request = makeApprovalRequest(clock.now);
      await coordinator.create(request);

      const outcomes = await Promise.allSettled([
        coordinator.decide(request.id, { status: "approved", approver }),
        coordinator.decide(request.id, { status: "rejected", approver }),
      ]);
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      const final = await coordinator.get(request.id);
      expect(["approved", "rejected"]).toContain(final!.status);
    });

    test("concurrent markConsumed: exactly one settles fulfilled (T8 race)", async () => {
      const { clock, coordinator } = await setup();
      const request = makeApprovalRequest(clock.now);
      await coordinator.create(request);
      await coordinator.decide(request.id, { status: "approved", approver });

      const outcomes = await Promise.allSettled([
        coordinator.markConsumed(request.id, "exe_a"),
        coordinator.markConsumed(request.id, "exe_b"),
      ]);
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      const final = await coordinator.get(request.id);
      expect(final!.status).toBe("consumed");
      expect(["exe_a", "exe_b"]).toContain(final!.consumedByExecutionId);
    });
  });
}
