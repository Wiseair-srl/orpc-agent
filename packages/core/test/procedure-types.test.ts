import { describe, expect, test } from "vitest";
import { os } from "@orpc/server";
import * as z from "zod";
import { agentProcedure } from "../src/procedure";
import type { AgentInvocationInfo } from "../src/types";

describe("agentProcedure", () => {
  test("returns the same builder object (no wrapper, no runtime change)", () => {
    const base = os.$context<{ db: string }>();
    const typed = agentProcedure(base);
    expect(typed).toBe(base);
  });

  test("type-checks agent meta and context.agent", () => {
    const base = os.$context<{ db: string }>();
    const agentBase = agentProcedure(base);

    const ok = agentBase
      .meta({
        agent: {
          description: "d",
          expose: { direct: true },
          sideEffect: "read",
          risk: "low",
        },
      })
      .input(z.object({}))
      .handler(async ({ context }) => {
        // context.agent is typed as AgentInvocationInfo | undefined.
        const info: AgentInvocationInfo | undefined = context.agent;
        return { executionId: info?.executionId };
      });
    expect(ok).toBeDefined();

    agentBase.meta({
      agent: {
        description: "d",
        expose: { direct: true },
        // @ts-expect-error — sideEffect must be one of the classification values
        sideEffect: "sometimes",
        risk: "low",
      },
    });

    agentBase.meta({
      agent: {
        description: "d",
        // @ts-expect-error — unknown surface keys are rejected at the type level
        expose: { http: true },
        sideEffect: "read",
        risk: "low",
      },
    });
  });
});
