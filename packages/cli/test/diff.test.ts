import { describe, expect, it } from "vitest";
import { diffSnapshots } from "../src/diff";
import type { CapabilityEntry, Change, ChangeKind } from "../src/types";
import { entry, snapshot } from "./fixtures";

/** The change for a field, or undefined — every assertion here is about one field. */
function on(changes: Change[], field: string): Change | undefined {
  return changes.find((change) => change.field === field);
}

function between(before: Partial<CapabilityEntry>, after: Partial<CapabilityEntry>): Change[] {
  return diffSnapshots(snapshot([entry(before)]), snapshot([entry(after)]));
}

function kindOf(before: Partial<CapabilityEntry>, after: Partial<CapabilityEntry>, field: string): ChangeKind | undefined {
  return on(between(before, after), field)?.kind;
}

describe("diffSnapshots", () => {
  it("reports nothing for an unchanged snapshot", () => {
    expect(between({}, {})).toEqual([]);
  });

  it("treats a new exposure as widening and a lost one as narrowing", () => {
    expect(kindOf({ expose: ["aiSdk"] }, { expose: ["aiSdk", "mcp"] }, "expose")).toBe("widening");
    expect(kindOf({ expose: ["aiSdk", "mcp"] }, { expose: ["aiSdk"] }, "expose")).toBe("narrowing");
  });

  it("treats a newly exposed capability as widening and a staged one as neutral", () => {
    const added = diffSnapshots(snapshot([]), snapshot([entry({ expose: ["mcp"] })]));
    const staged = diffSnapshots(snapshot([]), snapshot([entry({ expose: [] })]));

    expect(added[0]?.kind).toBe("widening");
    expect(added[0]?.message).toContain("mcp");
    expect(staged[0]?.kind).toBe("neutral");
  });

  it("treats a removed capability as narrowing", () => {
    const changes = diffSnapshots(snapshot([entry()]), snapshot([]));

    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe("narrowing");
  });

  it("treats dropping an approval gate as widening and adding one as narrowing", () => {
    expect(
      kindOf({ approval: { required: true } }, { approval: { required: false } }, "approval"),
    ).toBe("widening");
    expect(kindOf({ approval: { required: true } }, {}, "approval")).toBe("widening");
    expect(kindOf({}, { approval: { required: true } }, "approval")).toBe("narrowing");
  });

  it("treats a lowered risk as widening and a raised one as narrowing", () => {
    expect(kindOf({ risk: "critical" }, { risk: "low" }, "risk")).toBe("widening");
    expect(kindOf({ risk: "low" }, { risk: "critical" }, "risk")).toBe("narrowing");
  });

  // Declaring less than before stops policies keyed on the old value from
  // matching, so it is not the safe direction it looks like.
  it("treats a sideEffect change as widening in both directions", () => {
    expect(kindOf({ sideEffect: "read" }, { sideEffect: "write" }, "sideEffect")).toBe("widening");
    expect(kindOf({ sideEffect: "write" }, { sideEffect: "read" }, "sideEffect")).toBe("widening");
  });

  it("treats a removed policy as widening and an added one as narrowing", () => {
    expect(kindOf({ policies: ["cap"] }, { policies: [] }, "policies")).toBe("widening");
    expect(kindOf({ policies: [] }, { policies: ["cap"] }, "policies")).toBe("narrowing");
  });

  it("reports a policy reorder without calling it a gain or a loss", () => {
    const change = on(between({ policies: ["a", "b"] }, { policies: ["b", "a"] }), "policies");

    expect(change?.kind).toBe("neutral");
    expect(change?.message).toContain("order");
  });

  it("treats becoming idempotent as widening — it is what unlocks retries", () => {
    expect(kindOf({ idempotent: false }, { idempotent: true }, "idempotent")).toBe("widening");
    expect(kindOf({ idempotent: true }, { idempotent: false }, "idempotent")).toBe("narrowing");
  });

  it("treats added retries on a write as widening, but not on a read", () => {
    expect(
      kindOf({ sideEffect: "write" }, { sideEffect: "write", retry: { maxAttempts: 3, retryOn: false } }, "retry"),
    ).toBe("widening");
    expect(
      kindOf({ sideEffect: "read" }, { sideEffect: "read", retry: { maxAttempts: 3, retryOn: false } }, "retry"),
    ).toBe("neutral");
  });

  it("treats removed redaction as widening", () => {
    expect(
      kindOf(
        { redact: { output: true, approvalInput: false } },
        { redact: { output: false, approvalInput: false } },
        "redact.output",
      ),
    ).toBe("widening");
    expect(
      kindOf(
        { redact: { output: false, approvalInput: true } },
        { redact: { output: false, approvalInput: false } },
        "redact.approvalInput",
      ),
    ).toBe("widening");
  });

  it("reports contract changes as neutral", () => {
    expect(kindOf({ description: "a" }, { description: "b" }, "description")).toBe("neutral");
    expect(kindOf({ inputSchemaHash: "sha256:a" }, { inputSchemaHash: "sha256:b" }, "inputSchema")).toBe("neutral");
    expect(
      kindOf({ toolNames: { mcp: "old" } }, { toolNames: { mcp: "new" } }, "toolNames"),
    ).toBe("neutral");
    expect(kindOf({ tags: [] }, { tags: ["pii"] }, "tags")).toBe("neutral");
  });

  it("reports a procedure that lost its meta.agent as narrowing", () => {
    const changes = diffSnapshots(
      snapshot([entry()], { excluded: [] }),
      snapshot([], { excluded: ["orders.refund"] }),
    );

    expect(on(changes, "excluded")?.kind).toBe("narrowing");
  });

  it("does not double-report a procedure that became a capability", () => {
    const changes = diffSnapshots(
      snapshot([], { excluded: ["orders.refund"] }),
      snapshot([entry({ expose: ["mcp"] })]),
    );

    expect(changes).toHaveLength(1);
    expect(changes[0]?.field).toBe("capability");
  });

  describe("runtime policies", () => {
    const gate = { name: "gate-model-writes", phases: ["invocation" as const] };
    const withRuntime = (policies: { name: string; phases: ("invocation" | "discovery")[] }[]) =>
      snapshot([entry()], { runtime: { policies } });

    it("classifies a removed runtime policy as widening", () => {
      const changes = diffSnapshots(withRuntime([gate]), withRuntime([]));

      expect(on(changes, "runtime.policies")?.kind).toBe("widening");
      expect(on(changes, "runtime.policies")?.message).toContain("gate-model-writes");
    });

    it("classifies an added runtime policy as narrowing", () => {
      expect(on(diffSnapshots(withRuntime([]), withRuntime([gate])), "runtime.policies")?.kind).toBe(
        "narrowing",
      );
    });

    it("treats a policy that drops a phase as widening — it stops running there", () => {
      const before = withRuntime([{ name: "p", phases: ["invocation", "discovery"] }]);
      const after = withRuntime([{ name: "p", phases: ["discovery"] }]);

      expect(on(diffSnapshots(before, after), "runtime.policies")?.kind).toBe("widening");
      expect(on(diffSnapshots(after, before), "runtime.policies")?.kind).toBe("narrowing");
    });

    it("reports nothing when neither side observed a runtime", () => {
      expect(diffSnapshots(snapshot([entry()]), snapshot([entry()]))).toEqual([]);
    });

    it("distinguishes 'not observed' from 'observed, none' in both directions", () => {
      // Absent → present: the app did not change, the tool started looking.
      const started = diffSnapshots(snapshot([entry()]), withRuntime([]));
      expect(on(started, "runtime")?.kind).toBe("neutral");

      // Present → absent: the snapshot lost the ability to detect a removal.
      const stopped = diffSnapshots(withRuntime([]), snapshot([entry()]));
      expect(on(stopped, "runtime")?.kind).toBe("widening");
    });

    it("reports a reordering as neutral, matching capability-scoped policies", () => {
      const a = { name: "a", phases: ["invocation" as const] };
      const b = { name: "b", phases: ["invocation" as const] };

      expect(on(diffSnapshots(withRuntime([a, b]), withRuntime([b, a])), "runtime.policies")?.kind).toBe(
        "neutral",
      );
    });
  });

  it("does not diff unexposed, which is derived from the expose maps", () => {
    const changes = diffSnapshots(
      snapshot([entry({ expose: [] })], { unexposed: ["orders.refund"] }),
      snapshot([entry({ expose: [] })], { unexposed: [] }),
    );

    expect(changes).toEqual([]);
  });
});
