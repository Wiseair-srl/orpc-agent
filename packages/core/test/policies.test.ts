import { describe, expect, test } from "vitest";
import { os } from "@orpc/server";
import * as z from "zod";
import { createAgentRuntime } from "../src/runtime/create";
import { defineGovernance } from "../src/governance";
import { createCapabilityRegistry } from "../src/registry";
import { agentProcedure } from "../src/procedure";
import { composePolicies, definePolicy } from "../src/policy/define";
import { allow, deny, hide, requireApproval } from "../src/policy/helpers";
import { capturedEvents, dana, priya } from "./helpers";
import type { AgentPolicy, PolicyDecision, PolicyRequest } from "../src/policy/types";

const base = agentProcedure(os.$context<object>());
const options = { actor: dana, context: {} };

function cap(policies?: AgentPolicy[]) {
  return base
    .meta({
      agent: {
        description: "Target.",
        expose: { direct: true, aiSdk: true },
        sideEffect: "read",
        risk: "low",
        ...(policies ? { policies } : {}),
      },
    })
    .input(z.object({ amount: z.number().default(0) }))
    .handler(async () => ({ ok: true }));
}

function runtimeWith(policies: AgentPolicy[], capPolicies?: AgentPolicy[]) {
  const audit = capturedEvents();
  const registry = createCapabilityRegistry({ target: cap(capPolicies) });
  const runtime = createAgentRuntime({ governance: defineGovernance({ registry, policies }), audit: audit.sink, defaults: { policyTimeoutMs: 100 } });
  return { runtime, audit };
}

const P = {
  allow: (name = "p-allow") => definePolicy(name, () => allow({ note: name })),
  deny: (name = "p-deny") => definePolicy(name, () => deny("CODE_X", "Denied by test policy.")),
  hide: (name = "p-hide") => definePolicy(name, () => hide()),
  ra: (name = "p-ra", reason = `reason:${name}`, expiresInMs?: number) =>
    definePolicy(name, () =>
      requireApproval({ reason, approvalType: `type:${name}`, ...(expiresInMs ? { expiresInMs } : {}) }),
    ),
};

describe("precedence: deny > hide > require-approval > allow (all 2-policy combinations)", () => {
  const outcomes = {
    allow: "completed",
    deny: "failed:POLICY_DENIED",
    hide: "failed:CAPABILITY_NOT_FOUND",
    ra: "approval-required",
  } as const;
  type Kind = keyof typeof outcomes;
  const kinds: Kind[] = ["allow", "deny", "hide", "ra"];
  const expected: Record<string, string> = {
    "allow+allow": outcomes.allow,
    "allow+deny": outcomes.deny,
    "allow+hide": outcomes.hide,
    "allow+ra": outcomes.ra,
    "deny+deny": outcomes.deny,
    "deny+hide": outcomes.deny,
    "deny+ra": outcomes.deny,
    "hide+hide": outcomes.hide,
    "hide+ra": outcomes.hide,
    "ra+ra": outcomes.ra,
  };

  const pairs = kinds.flatMap((a, i) => kinds.slice(i).map((b) => [a, b] as const));
  test.each(pairs)("%s + %s", async (a, b) => {
    const { runtime } = runtimeWith([P[a](`first-${a}`), P[b](`second-${b}`)]);
    const result = await runtime.invoke("target", { amount: 1 }, options);
    const key = `${a}+${b}`;
    const want = expected[key]!;
    if (want === "completed") {
      expect(result.status).toBe("completed");
    } else if (want === "approval-required") {
      expect(result.status).toBe("approval-required");
    } else {
      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.error.code).toBe(want.split(":")[1]);
      }
    }
  });
});

describe("evaluation semantics", () => {
  test("all policies evaluate (no short-circuit); audit captures every stance in order", async () => {
    const evaluated: string[] = [];
    const first = definePolicy("first-deny", () => {
      evaluated.push("first-deny");
      return deny(undefined, "No.");
    });
    const second = definePolicy("second-allow", () => {
      evaluated.push("second-allow");
      return allow();
    });
    const { runtime, audit } = runtimeWith([first, second]);
    const result = await runtime.invoke("target", { amount: 1 }, options);
    expect(result.status).toBe("failed");
    expect(evaluated).toEqual(["first-deny", "second-allow"]);
    const denied = audit.ofType("capability.denied")[0]!;
    expect(denied.data.reason).toBe("policy-denied");
    expect(denied.data.publicCode).toBe("POLICY_DENIED");
    expect(denied.data.policyDecisions).toEqual([
      { policy: "first-deny", type: "deny" },
      { policy: "second-allow", type: "allow" },
    ]);
  });

  test("runtime-level policies run before capability-level policies", async () => {
    const order: string[] = [];
    const runtimeLevel = definePolicy("runtime-level", () => {
      order.push("runtime-level");
      return allow();
    });
    const capLevel = definePolicy("cap-level", () => {
      order.push("cap-level");
      return allow();
    });
    const { runtime } = runtimeWith([runtimeLevel], [capLevel]);
    await runtime.invoke("target", { amount: 1 }, options);
    expect(order).toEqual(["runtime-level", "cap-level"]);
  });

  test("deny public message reaches the model; policy name and code go to details", async () => {
    const { runtime } = runtimeWith([
      definePolicy("limit", () => deny("REFUND_TOO_LARGE", "Refunds of $5000 or more cannot be issued by agents.")),
    ]);
    const result = await runtime.invoke("target", { amount: 9000 }, options);
    if (result.status !== "failed") expect.unreachable();
    expect(result.error.code).toBe("POLICY_DENIED");
    expect(result.error.exposeToModel).toBe(true);
    expect(result.error.publicMessage).toBe("Refunds of $5000 or more cannot be issued by agents.");
    expect(result.error.details).toEqual({ policy: "limit", code: "REFUND_TOO_LARGE" });
  });

  test("policies receive validated input, actor, surface, phase, and context", async () => {
    const seen: PolicyRequest[] = [];
    const spy = definePolicy("spy", (req) => {
      seen.push(req);
      return allow();
    });
    const { runtime } = runtimeWith([spy]);
    await runtime.invoke("target", {}, { ...options, context: { tenant: "t1" } });
    expect(seen).toHaveLength(1);
    const req = seen[0]!;
    expect(req.phase).toBe("invocation");
    expect(req.capability.id).toBe("target");
    expect(req.surface).toBe("direct");
    expect(req.actor.id).toBe("u_dana");
    expect(req.context).toEqual({ tenant: "t1" });
    // Validated (defaulted) input, not raw (SI-6).
    expect(req.input).toEqual({ amount: 0 });
  });

  test("hide at invocation is byte-identical to unknown capability (SI-8)", async () => {
    const { runtime, audit } = runtimeWith([P.hide()]);
    const hidden = await runtime.invoke("target", { amount: 1 }, options);
    const unknown = await runtime.invoke("missing", { amount: 1 }, options);
    if (hidden.status !== "failed" || unknown.status !== "failed") expect.unreachable();
    expect({
      code: hidden.error.code,
      message: hidden.error.publicMessage,
      retryable: hidden.error.retryable,
      details: hidden.error.details,
    }).toEqual({
      code: unknown.error.code,
      message: unknown.error.publicMessage,
      retryable: unknown.error.retryable,
      details: unknown.error.details,
    });
    expect(audit.ofType("capability.denied").map((e) => e.data.reason)).toEqual([
      "hidden",
      "unknown",
    ]);
  });
});

describe("fail-closed (SI-7)", () => {
  test("a throwing policy produces POLICY_FAILED, concealed from models", async () => {
    const boom = definePolicy("boom", () => {
      throw new Error("db down");
    });
    const { runtime, audit } = runtimeWith([boom, P.allow()]);
    const result = await runtime.invoke("target", { amount: 1 }, options);
    if (result.status !== "failed") expect.unreachable();
    expect(result.error.code).toBe("POLICY_FAILED");
    expect(result.error.exposeToModel).toBe(false);
    const denied = audit.ofType("capability.denied")[0]!;
    expect(denied.data.reason).toBe("policy-failed");
    expect(denied.data.policyDecisions).toEqual([
      { policy: "boom", type: "error" },
      { policy: "p-allow", type: "allow" },
    ]);
  });

  test("a policy exceeding the batch timeout produces POLICY_FAILED", async () => {
    const slow = definePolicy(
      "slow",
      () => new Promise<PolicyDecision>((resolve) => setTimeout(() => resolve(allow()), 500)),
    );
    const { runtime } = runtimeWith([slow]);
    const result = await runtime.invoke("target", { amount: 1 }, options);
    if (result.status !== "failed") expect.unreachable();
    expect(result.error.code).toBe("POLICY_FAILED");
  });

  test("a policy returning garbage fails closed", async () => {
    const garbage = definePolicy("garbage", () => "yes" as never);
    const { runtime } = runtimeWith([garbage]);
    const result = await runtime.invoke("target", { amount: 1 }, options);
    if (result.status !== "failed") expect.unreachable();
    expect(result.error.code).toBe("POLICY_FAILED");
  });
});

describe("approval merging", () => {
  test("multiple require-approval decisions merge into ONE request: all reasons, all types, minimum expiry", async () => {
    const { runtime, audit } = runtimeWith([
      P.ra("ra-one", "First reason", 60_000),
      P.ra("ra-two", "Second reason", 30_000),
    ]);
    const result = await runtime.invoke("target", { amount: 1 }, options);
    if (result.status !== "approval-required") expect.unreachable();
    expect(result.approval.reasons).toEqual(["First reason", "Second reason"]);
    expect(result.approval.types).toEqual(["type:ra-one", "type:ra-two"]);
    const windowMs =
      result.approval.expiresAt.getTime() - result.approval.requestedAt.getTime();
    expect(windowMs).toBe(30_000);
    expect(audit.ofType("capability.approval_requested")).toHaveLength(1);
  });
});

describe("phases", () => {
  test("policies default to invocation-only and do not re-run at stage 9", async () => {
    let evaluations = 0;
    const counting = definePolicy("counting", () => {
      evaluations += 1;
      return allow();
    });
    const { runtime } = runtimeWith([counting]);
    await runtime.invoke("target", { amount: 1 }, options);
    expect(evaluations).toBe(1);
  });

  test("execution-phase policies run at stage 9 with phase 'execution'", async () => {
    const phases: string[] = [];
    const fresh = definePolicy(
      "freshness",
      (req) => {
        phases.push(req.phase);
        return req.phase === "execution" ? deny(undefined, "Stale world.") : allow();
      },
      { phases: ["invocation", "execution"] },
    );
    const { runtime, audit } = runtimeWith([fresh]);
    const result = await runtime.invoke("target", { amount: 1 }, options);
    if (result.status !== "failed") expect.unreachable();
    expect(result.error.code).toBe("POLICY_DENIED");
    expect(phases).toEqual(["invocation", "execution"]);
    // Stage 9 denials surface as capability.failed with full policy decisions.
    const failed = audit.ofType("capability.failed")[0]!;
    expect(failed.data.policyDecisions).toEqual([
      { policy: "freshness", type: "allow" },
      { policy: "freshness", type: "deny" },
    ]);
  });
});

describe("composePolicies", () => {
  test("preserves order and per-policy audit identity", async () => {
    const composed = composePolicies(P.allow("inner-a"), P.deny("inner-b"));
    const { runtime, audit } = runtimeWith([composed]);
    const result = await runtime.invoke("target", { amount: 1 }, options);
    expect(result.status).toBe("failed");
    expect(audit.ofType("capability.denied")[0]!.data.policyDecisions).toEqual([
      { policy: "inner-a", type: "allow" },
      { policy: "inner-b", type: "deny" },
    ]);
  });

  test("standalone composite evaluation applies precedence", async () => {
    const composed = composePolicies(P.allow("a"), P.ra("b"), P.deny("c"));
    const decision = await composed.evaluate({
      phase: "invocation",
      capability: { id: "x", meta: {} as never },
      surface: "direct",
      actor: dana,
      context: {},
      input: {},
    });
    expect(decision.type).toBe("deny");
  });
});

describe("discovery pipeline (describe)", () => {
  function discoveryRuntime() {
    const audit = capturedEvents();
    const visible = cap();
    const hiddenForDana = base
      .meta({
        agent: {
          description: "Sensitive.",
          expose: { direct: true, aiSdk: true },
          sideEffect: "read",
          risk: "high",
          policies: [
            definePolicy(
              "hide-from-dana",
              ({ actor }) => (actor.id === "u_dana" ? hide() : allow()),
              { phases: ["discovery", "invocation"] },
            ),
          ],
        },
      })
      .input(z.object({}))
      .handler(async () => ({})),
      approvalGated = base
        .meta({
          agent: {
            description: "Gated.",
            expose: { direct: true },
            sideEffect: "write",
            risk: "high",
            approval: { required: true },
          },
        })
        .input(z.object({}))
        .handler(async () => ({}));
    const policyGated = base
      .meta({
        agent: {
          description: "Policy gated.",
          expose: { direct: true },
          sideEffect: "write",
          risk: "medium",
          policies: [
            definePolicy("needs-approval", () => requireApproval({ reason: "Because." }), {
              phases: ["discovery", "invocation"],
            }),
          ],
        },
      })
      .input(z.object({}))
      .handler(async () => ({}));
    const brokenPolicy = base
      .meta({
        agent: {
          description: "Broken.",
          expose: { direct: true },
          sideEffect: "read",
          risk: "low",
          policies: [
            definePolicy(
              "explodes",
              () => {
                throw new Error("boom");
              },
              { phases: ["discovery"] },
            ),
          ],
        },
      })
      .input(z.object({}))
      .handler(async () => ({}));
    const notExposed = base
      .meta({
        agent: {
          description: "Not here.",
          expose: { mcp: true },
          sideEffect: "read",
          risk: "low",
        },
      })
      .input(z.object({}))
      .handler(async () => ({}));

    const registry = createCapabilityRegistry({
      visible,
      sensitive: hiddenForDana,
      gated: approvalGated,
      policyGated,
      broken: brokenPolicy,
      notExposed,
    });
    const runtime = createAgentRuntime({ governance: defineGovernance({ registry }), audit: audit.sink });
    return { runtime, audit };
  }

  test("excludes unexposed, hidden, and failing-policy capabilities; annotates approvals", async () => {
    const { runtime, audit } = discoveryRuntime();
    const descriptors = await runtime.describe("direct", { actor: dana, context: {} });
    expect(descriptors.map((d) => d.id)).toEqual(["visible", "gated", "policyGated"]);

    const gated = descriptors.find((d) => d.id === "gated")!;
    expect(gated.requiresApproval).toBe(true);
    const policyGated = descriptors.find((d) => d.id === "policyGated")!;
    expect(policyGated.requiresApproval).toBe(true);
    const visible = descriptors.find((d) => d.id === "visible")!;
    expect(visible.requiresApproval).toBeUndefined();
    expect(visible.inputSchema).toMatchObject({ type: "object" });
    expect(visible.sideEffect).toBe("read");

    const discovered = audit.ofType("capabilities.discovered")[0]!;
    expect(discovered.data.count).toBe(3);
    expect(discovered.data.capabilityIds).toBeUndefined();
    expect(discovered.executionId).toBeUndefined();
  });

  test("visibility is per-actor: the same runtime lists differently for another actor", async () => {
    const { runtime } = discoveryRuntime();
    const forPriya = await runtime.describe("direct", { actor: priya, context: {} });
    expect(forPriya.map((d) => d.id)).toContain("sensitive");
  });

  test("discovery policies see input === undefined", async () => {
    const inputs: unknown[] = [];
    const spy = definePolicy(
      "discovery-spy",
      (req) => {
        inputs.push(req.input);
        return allow();
      },
      { phases: ["discovery"] },
    );
    const { runtime } = runtimeWith([spy]);
    await runtime.describe("direct", { actor: dana, context: {} });
    expect(inputs).toEqual([undefined]);
  });

  test("hidden-at-discovery capability still concealed at invocation (SI-2)", async () => {
    const { runtime } = discoveryRuntime();
    const result = await runtime.invoke("sensitive", {}, options);
    if (result.status !== "failed") expect.unreachable();
    expect(result.error.code).toBe("CAPABILITY_NOT_FOUND");
  });
});
