import { describe, expect, test } from "vitest";
import { signalObservations, EXPECTED_TOOL_NAMES } from "./registry";

/**
 * Adapter conformance checklist (docs/adapters/testing.md#adapter-conformance)
 * as a describe-block factory. Every adapter package runs it against the
 * fixture registry via a small harness.
 */

export type AdapterEnvelope =
  | { status: "ok"; data: unknown }
  | { status: "approval-required"; approvalId: string; message: string }
  | {
      status: "error";
      error: { code: string; message: string; retryable: boolean; details?: unknown };
    };

export type ConformanceHarness = {
  /** Tool names listed for the default session/actor. */
  listToolNames(): Promise<string[]>;
  /** Tool description as listed on the protocol, by tool name. */
  toolDescription(name: string): Promise<string | undefined>;
  /** Call a tool by protocol name with RAW args; return the parsed envelope. */
  callTool(
    name: string,
    args: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<AdapterEnvelope>;
  /** Build the adapter with a name-colliding toolNaming — must throw. */
  buildWithCollidingNaming(): Promise<unknown>;
};

export function describeAdapterConformance(
  adapterName: string,
  makeHarness: () => Promise<ConformanceHarness>,
): void {
  describe(`adapter conformance: ${adapterName}`, () => {
    test("1. discovery lists exactly the exposed, non-hidden capabilities", async () => {
      const harness = await makeHarness();
      const names = await harness.listToolNames();
      expect([...names].sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
      expect(names).not.toContain("fixtures_hidden");
      expect(names).not.toContain("fixtures_unexposed");
    });

    test("1b. approval-gated tools carry the approval suffix in their description", async () => {
      const harness = await makeHarness();
      expect(await harness.toolDescription("fixtures_gated")).toBe(
        "A gated write. Requires approval.",
      );
      expect(await harness.toolDescription("fixtures_echo")).toBe("Echo the text back.");
    });

    test("2. raw arguments reach the runtime unvalidated (INPUT_INVALID from the runtime)", async () => {
      const harness = await makeHarness();
      const envelope = await harness.callTool("fixtures_echo", { text: 42 });
      expect(envelope.status).toBe("error");
      if (envelope.status !== "error") return;
      expect(envelope.error.code).toBe("INPUT_INVALID");
      // Issue details pass through — the model authored the data.
      expect(envelope.error.details).toBeDefined();
    });

    test("3. all four envelope statuses translate deterministically", async () => {
      const harness = await makeHarness();

      const ok = await harness.callTool("fixtures_echo", { text: "hi" });
      expect(ok).toEqual({ status: "ok", data: { echoed: "hi" } });

      const approval = await harness.callTool("fixtures_gated", { target: "x" });
      expect(approval.status).toBe("approval-required");
      if (approval.status === "approval-required") {
        expect(approval.approvalId).toMatch(/^apr_/);
        expect(approval.message).toMatch(/^Awaiting approval/);
      }

      const denied = await harness.callTool("fixtures_denied", {});
      expect(denied).toEqual({
        status: "error",
        error: {
          code: "POLICY_DENIED",
          message: "This operation is not allowed for agents.",
          retryable: false,
        },
      });

      const concealed = await harness.callTool("fixtures_concealedError", {});
      expect(concealed).toEqual({
        status: "error",
        error: { code: "INTERNAL_ERROR", message: "The operation failed.", retryable: false },
      });
    });

    test("3b. concealment: unknown, unexposed, and hidden are byte-identical (SI-8)", async () => {
      const harness = await makeHarness();
      const unknown = await harness.callTool("fixtures_doesNotExist", {});
      const unexposed = await harness.callTool("fixtures_unexposed", {});
      const hidden = await harness.callTool("fixtures_hidden", {});
      expect(unknown.status).toBe("error");
      expect(JSON.stringify(unexposed)).toBe(JSON.stringify(unknown));
      expect(JSON.stringify(hidden)).toBe(JSON.stringify(unknown));
      if (unknown.status === "error") {
        expect(unknown.error.code).toBe("CAPABILITY_NOT_FOUND");
      }
    });

    test("4. tool-name mapping is bijective; collisions fail at build", async () => {
      const harness = await makeHarness();
      const viaOverride = await harness.callTool("custom_name", {});
      expect(viaOverride).toEqual({ status: "ok", data: { renamed: true } });
      // The capability id is NOT callable when an override names the tool.
      const byId = await harness.callTool("fixtures_renamed", {});
      expect(byId.status).toBe("error");
      await expect(harness.buildWithCollidingNaming()).rejects.toThrowError(/collision/i);
    });

    test("5. cancellation propagates from the protocol signal to the handler", async () => {
      const harness = await makeHarness();
      const before = signalObservations.length;
      const controller = new AbortController();
      const pending = harness.callTool("fixtures_slow", {}, { signal: controller.signal });
      setTimeout(() => controller.abort(), 25);
      const envelope = await pending;
      expect(envelope.status).toBe("error");
      if (envelope.status === "error") {
        expect(["CANCELLED", "TIMEOUT"]).toContain(envelope.error.code);
      }
      const observation = signalObservations[before];
      expect(observation?.aborted).toBe(true);
    });
  });
}
