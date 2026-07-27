import { describe, expect, test } from "vitest";
import { ORPCError, call, os } from "@orpc/server";
import * as z from "zod";
import { createAgentRuntime } from "../src/runtime/create";
import { createCapabilityRegistry } from "../src/registry";
import { agentProcedure } from "../src/procedure";
import { CapabilityError } from "../src/errors";
import { unwrap } from "../src/unwrap";
import { capturedEvents, dana } from "./helpers";
import type { AgentInvocationInfo } from "../src/types";

type Ctx = { organizationId?: string; agent?: AgentInvocationInfo };
const base = agentProcedure(os.$context<Ctx>());

const meta = {
  description: "Test capability.",
  expose: { direct: true, test: true },
  sideEffect: "read",
  risk: "low",
} as const;

const echo = base
  .meta({ agent: { ...meta } })
  .input(z.object({ value: z.string(), limit: z.number().int().default(5) }))
  .output(z.object({ value: z.string(), limit: z.number() }))
  .handler(async ({ input }) => input);

const seenAgent: (AgentInvocationInfo | undefined)[] = [];
const introspect = base
  .meta({ agent: { ...meta } })
  .input(z.object({}))
  .handler(async ({ context }) => {
    seenAgent.push(context.agent);
    return { ok: true };
  });

const declaredError = base
  .meta({ agent: { ...meta } })
  .errors({ NOT_ELIGIBLE: { message: "Order is not eligible for refund." } })
  .input(z.object({}))
  .handler(async ({ errors }) => {
    throw errors.NOT_ELIGIBLE();
  });

const secretThrow = base
  .meta({ agent: { ...meta } })
  .input(z.object({}))
  .handler(async () => {
    throw new Error("pg: secret_table does not exist");
  });

const unauthorized = base
  .meta({ agent: { ...meta } })
  .input(z.object({}))
  .handler(async () => {
    throw new ORPCError("UNAUTHORIZED");
  });

const guarded = base
  .use(async ({ context, next }) => {
    if (context.organizationId !== "org_1") {
      throw new ORPCError("FORBIDDEN", { message: "Wrong organization." });
    }
    return next();
  })
  .meta({ agent: { ...meta } })
  .input(z.object({}))
  .handler(async () => ({ ok: true }));

const badOutput = base
  .meta({ agent: { ...meta } })
  .input(z.object({}))
  .output(z.object({ mustExist: z.string() }))
  .handler(async () => ({ wrong: true }) as never);

const redacted = base
  .meta({
    agent: {
      ...meta,
      redact: { output: (o) => ({ ...(o as object), secret: undefined }) },
    },
  })
  .input(z.object({}))
  .output(z.object({ visible: z.string(), secret: z.string() }))
  .handler(async () => ({ visible: "yes", secret: "gateway-ref-123" }));

const redactThrows = base
  .meta({
    agent: {
      ...meta,
      redact: {
        output: () => {
          throw new Error("redaction bug");
        },
      },
    },
  })
  .input(z.object({}))
  .handler(async () => ({ ok: true }));

function makeRuntime(extra?: Parameters<typeof createAgentRuntime>[0]["audit"]) {
  const audit = capturedEvents();
  const registry = createCapabilityRegistry({
    echo,
    introspect,
    declaredError,
    secretThrow,
    unauthorized,
    guarded,
    badOutput,
    redacted,
    redactThrows,
    hiddenFromDirect: base
      .meta({ agent: { ...meta, expose: { test: true } } })
      .input(z.object({}))
      .handler(async () => ({ ok: true })),
  });
  const runtime = createAgentRuntime<Ctx>({
    registry,
    audit: extra ?? audit.sink,
  });
  return { runtime, audit };
}

const options = { actor: dana, context: { organizationId: "org_1" } as Ctx };

describe("stage order and audit sequences", () => {
  test("success path: requested → started → completed; envelope carries redacted-free output", async () => {
    const { runtime, audit } = makeRuntime();
    const result = await runtime.invoke("echo", { value: "hi" }, options);
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      // Validated (defaulted) input reached the handler (SI-6).
      expect(result.output).toEqual({ value: "hi", limit: 5 });
    }
    expect(audit.types()).toEqual([
      "capability.requested",
      "capability.started",
      "capability.completed",
    ]);
    const completed = audit.ofType("capability.completed")[0]!;
    expect(completed.data.attempts).toBe(1);
    expect(completed.executionId).toMatch(/^exe_/);
    expect(completed.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(completed.capabilityId).toBe("echo");
  });

  test("unknown capability: requested → denied(unknown)", async () => {
    const { runtime, audit } = makeRuntime();
    const result = await runtime.invoke("no.such", {}, options);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe("CAPABILITY_NOT_FOUND");
    }
    expect(audit.types()).toEqual(["capability.requested", "capability.denied"]);
    expect(audit.ofType("capability.denied")[0]!.data).toEqual({
      reason: "unknown",
      publicCode: "CAPABILITY_NOT_FOUND",
    });
  });

  test("unexposed surface: concealed externally, audited truthfully (SI-8)", async () => {
    const { runtime, audit } = makeRuntime();
    const unknown = await runtime.invoke("no.such", {}, options);
    const unexposed = await runtime.invoke("hiddenFromDirect", {}, options);
    expect(unexposed.status).toBe("failed");
    if (unexposed.status === "failed" && unknown.status === "failed") {
      // Byte-identical external shape.
      expect(serializeExternal(unexposed.error)).toEqual(serializeExternal(unknown.error));
    }
    const reasons = audit.ofType("capability.denied").map((e) => e.data.reason);
    expect(reasons).toEqual(["unknown", "not-exposed"]);
  });

  test("invalid input: INPUT_INVALID with issue paths, no values echoed", async () => {
    const { runtime, audit } = makeRuntime();
    const result = await runtime.invoke("echo", { value: 42, limit: "x" }, options);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe("INPUT_INVALID");
      expect(result.error.retryable).toBe(false);
      expect(result.error.exposeToModel).toBe(true);
      const details = result.error.details as { issues: { path: string[]; message: string }[] };
      expect(details.issues.map((i) => i.path.join("."))).toEqual(
        expect.arrayContaining(["value", "limit"]),
      );
    }
    expect(audit.types()).toEqual(["capability.requested", "capability.failed"]);
    expect(audit.ofType("capability.failed")[0]!.data.stage).toBe("input-validation");
    // Hash absent — validation never succeeded.
    expect(audit.ofType("capability.failed")[0]!.inputHash).toBeUndefined();
  });

  test("missing/malformed actor: UNAUTHENTICATED", async () => {
    const { runtime } = makeRuntime();
    const missing = await runtime.invoke("echo", { value: "hi" }, {
      context: {},
    } as never);
    expect(missing.status).toBe("failed");
    if (missing.status === "failed") expect(missing.error.code).toBe("UNAUTHENTICATED");

    const malformed = await runtime.invoke("echo", { value: "hi" }, {
      actor: { id: "", kind: "user" },
      context: {},
    });
    expect(malformed.status).toBe("failed");
    if (malformed.status === "failed") expect(malformed.error.code).toBe("UNAUTHENTICATED");
  });
});

describe("oRPC error mapping at stage 11", () => {
  test("declared type-safe errors are contract: exposed with their message", async () => {
    const { runtime } = makeRuntime();
    const result = await runtime.invoke("declaredError", {}, options);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe("EXECUTION_FAILED");
      expect(result.error.exposeToModel).toBe(true);
      expect(result.error.publicMessage).toBe("Order is not eligible for refund.");
    }
  });

  test("undeclared throws are concealed (SI-9)", async () => {
    const { runtime } = makeRuntime();
    const result = await runtime.invoke("secretThrow", {}, options);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe("EXECUTION_FAILED");
      expect(result.error.exposeToModel).toBe(false);
      expect(result.error.publicMessage).toBe("The operation failed.");
      expect(result.error.publicMessage).not.toMatch(/secret_table/);
      // The true error is preserved privately for logs.
      expect(String((result.error.cause as Error).message)).toMatch(/secret_table/);
    }
  });

  test("ORPCError UNAUTHORIZED → UNAUTHENTICATED (stage authentication)", async () => {
    const { runtime } = makeRuntime();
    const result = await runtime.invoke("unauthorized", {}, options);
    if (result.status !== "failed") expect.unreachable();
    expect(result.error.code).toBe("UNAUTHENTICATED");
    expect(result.error.stage).toBe("authentication");
  });

  test("middleware FORBIDDEN → FORBIDDEN (stage authorization); middleware runs on agent path", async () => {
    const { runtime } = makeRuntime();
    const result = await runtime.invoke("guarded", {}, {
      actor: dana,
      context: { organizationId: "org_2" },
    });
    if (result.status !== "failed") expect.unreachable();
    expect(result.error.code).toBe("FORBIDDEN");
    expect(result.error.stage).toBe("authorization");
    expect(result.error.publicMessage).toBe("Wrong organization.");

    const ok = await runtime.invoke("guarded", {}, options);
    expect(ok.status).toBe("completed");
  });
});

describe("output validation and redaction", () => {
  test("OUTPUT_INVALID withholds output and marks executedBeforeFailure", async () => {
    const { runtime, audit } = makeRuntime();
    const result = await runtime.invoke("badOutput", {}, options);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe("OUTPUT_INVALID");
      expect(result.error.exposeToModel).toBe(false);
      expect((result as { output?: unknown }).output).toBeUndefined();
    }
    const failed = audit.ofType("capability.failed")[0]!;
    expect(failed.data.executedBeforeFailure).toBe(true);
    expect(failed.data.stage).toBe("output-validation");
  });

  test("redact.output runs before the envelope leaves the runtime", async () => {
    const { runtime } = makeRuntime();
    const result = await runtime.invoke("redacted", {}, options);
    if (result.status !== "completed") expect.unreachable();
    expect((result.output as { visible: string }).visible).toBe("yes");
    expect((result.output as { secret?: string }).secret).toBeUndefined();
  });

  test("throwing redaction fails the execution with executedBeforeFailure", async () => {
    const { runtime, audit } = makeRuntime();
    const result = await runtime.invoke("redactThrows", {}, options);
    if (result.status !== "failed") expect.unreachable();
    expect(result.error.code).toBe("EXECUTION_FAILED");
    expect(result.error.exposeToModel).toBe(false);
    expect(audit.ofType("capability.failed")[0]!.data.executedBeforeFailure).toBe(true);
  });
});

describe("ctx.agent injection", () => {
  test("agent info is injected on runtime invocations", async () => {
    const { runtime } = makeRuntime();
    seenAgent.length = 0;
    await runtime.invoke("introspect", {}, { ...options, correlationId: "run_9" });
    expect(seenAgent).toHaveLength(1);
    const info = seenAgent[0]!;
    expect(info.capabilityId).toBe("introspect");
    expect(info.surface).toBe("direct");
    expect(info.actor.id).toBe("u_dana");
    expect(info.executionId).toMatch(/^exe_/);
    expect(info.idempotencyKey).toMatch(/^idk_/);
    expect(info.correlationId).toBe("run_9");
    expect(info.approval).toBeUndefined();
  });

  test("context.agent is absent on plain oRPC calls of the same procedure", async () => {
    seenAgent.length = 0;
    await call(introspect, {}, { context: { organizationId: "org_1" } });
    expect(seenAgent).toHaveLength(1);
    expect(seenAgent[0]).toBeUndefined();
  });
});

describe("audit strict mode", () => {
  test("strict: capability.started sink failure aborts with AUDIT_UNAVAILABLE before execution", async () => {
    let handlerRan = false;
    const probe = base
      .meta({ agent: { ...meta } })
      .input(z.object({}))
      .handler(async () => {
        handlerRan = true;
        return {};
      });
    const registry = createCapabilityRegistry({ probe });
    const runtime = createAgentRuntime<Ctx>({
      registry,
      audit: {
        sinks: [
          (event) => {
            if (event.type === "capability.started") throw new Error("sink down");
          },
        ],
        strict: true,
      },
    });
    const result = await runtime.invoke("probe", {}, options);
    if (result.status !== "failed") expect.unreachable();
    expect(result.error.code).toBe("AUDIT_UNAVAILABLE");
    expect(result.error.retryable).toBe(true);
    expect(handlerRan).toBe(false);
  });

  test("best-effort: throwing sinks invoke onSinkError and never fail the execution", async () => {
    const errors: unknown[] = [];
    const registry = createCapabilityRegistry({ echo });
    const runtime = createAgentRuntime<Ctx>({
      registry,
      audit: {
        sinks: [
          () => {
            throw new Error("sink down");
          },
        ],
        onSinkError: (err) => errors.push(err),
      },
    });
    const result = await runtime.invoke("echo", { value: "hi" }, options);
    expect(result.status).toBe("completed");
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("envelope discipline", () => {
  test("governed failures never throw; programmer errors do", async () => {
    const { runtime } = makeRuntime();
    const adversarial = [
      () => runtime.invoke("nope", {}, options),
      () => runtime.invoke("echo", Symbol("weird") as never, options),
      () => runtime.invoke("secretThrow", {}, options),
      () => runtime.invoke("echo", { value: "x" }, { ...options, surface: "mcp" }),
      () => runtime.invoke("echo", { value: "x" }, { actor: null as never, context: {} }),
    ];
    for (const run of adversarial) {
      const result = await run();
      expect(["failed", "cancelled"]).toContain(result.status);
      if (result.status === "failed") {
        expect(result.error).toBeInstanceOf(CapabilityError);
      }
    }
    // @ts-expect-error — options omitted entirely is a programmer error
    expect(() => runtime.invoke("echo", {})).toThrowError(TypeError);
    expect(() => runtime.invoke("", {}, options)).toThrowError(TypeError);
  });

  test("unwrap: returns output, throws CapabilityError for failures", async () => {
    const { runtime } = makeRuntime();
    const ok = await runtime.invoke("echo", { value: "hi" }, options);
    expect(unwrap(ok)).toEqual({ value: "hi", limit: 5 });

    const bad = await runtime.invoke("nope", {}, options);
    expect(() => unwrap(bad)).toThrowError(CapabilityError);
    try {
      unwrap(bad);
    } catch (error) {
      expect((error as CapabilityError).code).toBe("CAPABILITY_NOT_FOUND");
    }
  });
});

function serializeExternal(error: CapabilityError) {
  return {
    code: error.code,
    message: error.publicMessage,
    retryable: error.retryable,
    exposeToModel: error.exposeToModel,
    details: error.details,
  };
}
