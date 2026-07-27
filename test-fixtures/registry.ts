import { os } from "@orpc/server";
import * as z from "zod";
import {
  agentProcedure,
  allow,
  createCapabilityRegistry,
  definePolicy,
  deny,
  hide,
  type AgentInvocationInfo,
} from "@orpc-agent/core";

/**
 * Fixture registry for the adapter conformance checklist
 * (docs/adapters/testing.md#adapter-conformance). Everything is exposed to
 * BOTH aiSdk and mcp so one registry serves every adapter suite.
 */

export type FixtureContext = { agent?: AgentInvocationInfo };

const base = agentProcedure(os.$context<FixtureContext>());
const bothSurfaces = { aiSdk: true, mcp: true, direct: true, test: true } as const;

/** Cancellation observations shared with the conformance suite. */
export const signalObservations: { aborted: boolean }[] = [];

export const hideAlways = definePolicy("hide-always", () => hide(), {
  phases: ["discovery", "invocation"],
});

export function buildFixtureRegistry() {
  const echo = base
    .meta({
      agent: {
        description: "Echo the text back.",
        expose: bothSurfaces,
        sideEffect: "none",
        risk: "low",
      },
    })
    .input(z.object({ text: z.string() }))
    .output(z.object({ echoed: z.string() }))
    .handler(async ({ input }) => ({ echoed: input.text }));

  const gated = base
    .meta({
      agent: {
        description: "A gated write.",
        expose: bothSurfaces,
        sideEffect: "write",
        risk: "high",
        approval: { required: true, type: "human-confirmation" },
      },
    })
    .input(z.object({ target: z.string() }))
    .handler(async () => ({ done: true }));

  const denied = base
    .meta({
      agent: {
        description: "Denied by policy.",
        expose: bothSurfaces,
        sideEffect: "read",
        risk: "low",
        policies: [
          definePolicy("always-deny", () =>
            deny("NOPE", "This operation is not allowed for agents."),
          ),
        ],
      },
    })
    .input(z.object({}))
    .handler(async () => ({}));

  const concealedError = base
    .meta({
      agent: {
        description: "Fails with an internal error.",
        expose: bothSurfaces,
        sideEffect: "read",
        risk: "low",
      },
    })
    .input(z.object({}))
    .handler(async () => {
      throw new Error("secret internal detail: users_table");
    });

  const hidden = base
    .meta({
      agent: {
        description: "Hidden by policy.",
        expose: bothSurfaces,
        sideEffect: "read",
        risk: "low",
        policies: [hideAlways],
      },
    })
    .input(z.object({}))
    .handler(async () => ({}));

  const unexposed = base
    .meta({
      agent: {
        description: "Only reachable directly.",
        expose: { direct: true },
        sideEffect: "read",
        risk: "low",
      },
    })
    .input(z.object({}))
    .handler(async () => ({}));

  const renamed = base
    .meta({
      agent: {
        description: "Custom protocol name.",
        expose: bothSurfaces,
        sideEffect: "read",
        risk: "low",
        adapters: { aiSdk: { toolName: "custom_name" }, mcp: { toolName: "custom_name" } },
      },
    })
    .input(z.object({}))
    .handler(async () => ({ renamed: true }));

  const slow = base
    .meta({
      agent: {
        description: "Waits until aborted.",
        expose: bothSurfaces,
        sideEffect: "read",
        risk: "low",
        timeoutMs: 5_000,
      },
    })
    .input(z.object({}))
    .handler(({ signal }) => {
      const observation = { aborted: false };
      signalObservations.push(observation);
      return new Promise((_, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            observation.aborted = true;
            reject(signal.reason);
          },
          { once: true },
        );
      });
    });

  return createCapabilityRegistry({
    fixtures: { echo, gated, denied, concealedError, hidden, unexposed, renamed, slow },
  });
}

/** Names the conformance suite expects for the fixture registry, in order. */
export const EXPECTED_TOOL_NAMES = [
  "fixtures_echo",
  "fixtures_gated",
  "fixtures_denied",
  "fixtures_concealedError",
  "custom_name",
  "fixtures_slow",
];

/**
 * A naming function that collapses every capability id to one name. Adapters
 * must throw at build when it produces collisions (meta overrides exempt —
 * they still win over the naming function).
 */
export const collidingToolNaming = (): string => "collided_name";

export const conformancePolicies = [
  definePolicy("noop-allow", () => allow(), { phases: ["invocation"] }),
];
