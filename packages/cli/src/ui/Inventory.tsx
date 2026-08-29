import React from "react";
import { Box, Text } from "ink";
import {
  capabilityMeta,
  capabilityPolicies,
  inventoryHeadline,
  runtimeScope,
  type Verbosity,
} from "../render";
import type { CapabilitySnapshot, EntrySource } from "../types";
import { Badge, Callout, Heading, RISK_COLOR, SIDE_EFFECT_COLOR } from "./theme";

/**
 * The `inspect` view for a human at a terminal. Same facts as
 * `renderInventory`, laid out so the two that get misread are hard to miss:
 * the approval count is qualified as a declaration, and the runtime-policy
 * state is a panel rather than a trailing line.
 */
export function Inventory({
  snapshot,
  entrySource,
  verbosity = "normal",
}: {
  snapshot: CapabilitySnapshot;
  entrySource: EntrySource;
  verbosity?: Verbosity;
}) {
  const [size, governance] = inventoryHeadline(snapshot, entrySource);

  const widths = {
    id: Math.max(10, ...snapshot.capabilities.map((c) => c.id.length)),
    effect: 11,
    risk: 8,
    expose: Math.max(6, ...snapshot.capabilities.map((c) => c.expose.join(", ").length)),
    approval: 8,
  };

  return (
    <Box flexDirection="column">
      <Text bold>{size}</Text>
      <Text dimColor>{governance}</Text>

      {verbosity !== "min" && (
        <>
          <Box marginTop={1}>
            <Text dimColor>
              {"CAPABILITY".padEnd(widths.id)}  {"EFFECT".padEnd(widths.effect)}{" "}
              {"RISK".padEnd(widths.risk)} {"EXPOSE".padEnd(widths.expose)}{" "}
              {"APPROVAL".padEnd(widths.approval)} POLICIES
            </Text>
          </Box>
          {snapshot.capabilities.map((capability) => (
            <Box key={capability.id} flexDirection="column">
              <Box>
                <Text>{capability.id.padEnd(widths.id)}</Text>
                <Text>{"  "}</Text>
                <Badge
                  label={capability.sideEffect.padEnd(widths.effect)}
                  color={SIDE_EFFECT_COLOR[capability.sideEffect] ?? "white"}
                />
                <Text>{" "}</Text>
                <Badge
                  label={capability.risk.padEnd(widths.risk)}
                  color={RISK_COLOR[capability.risk] ?? "white"}
                />
                <Text>{" "}</Text>
                <Text>{(capability.expose.join(", ") || "—").padEnd(widths.expose)}</Text>
                <Text>{" "}</Text>
                <Text color={capability.approval?.required ? "green" : undefined}>
                  {(capability.approval?.required ? "required" : "—").padEnd(widths.approval)}
                </Text>
                <Text>{" "}</Text>
                <Text dimColor={capabilityPolicies(snapshot, capability).length === 0}>
                  {capabilityPolicies(snapshot, capability).join(", ") || "—"}
                </Text>
              </Box>
              {verbosity === "detail" &&
                capabilityMeta(capability).map((line) => (
                  <Text key={line} dimColor>
                    {"  "}
                    {line}
                  </Text>
                ))}
            </Box>
          ))}

          <RuntimePanel snapshot={snapshot} entrySource={entrySource} verbosity={verbosity} />

          {snapshot.unexposed.length > 0 && (
            <>
              <Heading>Defined, reachable nowhere</Heading>
              {snapshot.unexposed.map((id) => (
                <Text key={id} dimColor>
                  {"  "}
                  {id}
                </Text>
              ))}
            </>
          )}
          {snapshot.excluded.length > 0 && (
            <>
              <Heading>Excluded — no meta.agent, on no surface</Heading>
              {snapshot.excluded.map((path) => (
                <Text key={path} dimColor>
                  {"  "}
                  {path}
                </Text>
              ))}
            </>
          )}
        </>
      )}
    </Box>
  );
}

function RuntimePanel({
  snapshot,
  entrySource,
  verbosity,
}: {
  snapshot: CapabilitySnapshot;
  entrySource: EntrySource;
  verbosity: Verbosity;
}) {
  if (!snapshot.runtime) {
    return (
      <Callout tone="warn" title="Runtime policies — NOT OBSERVED">
        {entrySource === "runtime-unreported" ? (
          <Text>
            The runtime came from a version of @orpc-agent/core that does not carry its
            governance. Upgrade core to record its policies.
          </Text>
        ) : (
          <Text>
            <Text>--entry resolved a bare capability registry, which names no policies. If this</Text>
            <Text> application registers runtime-level policies, those gates are missing from</Text>
            <Text> this inventory and from the snapshot — deleting one will not fail the gate.</Text>
            <Text bold> Declare them with </Text>
            <Text bold color="cyan">defineGovernance(&#123; registry, policies &#125;)</Text>
            <Text bold> and point --entry at that export.</Text>
          </Text>
        )}
      </Callout>
    );
  }

  if (snapshot.runtime.policies.length === 0) {
    return (
      <Box marginTop={1}>
        <Text bold>Runtime policies</Text>
        <Text dimColor> — none configured</Text>
      </Box>
    );
  }

  const widths = {
    name: Math.max("POLICY".length, ...snapshot.runtime.policies.map((p) => p.name.length)),
    phases: Math.max("PHASES".length, ...snapshot.runtime.policies.map((p) => p.phases.join(", ").length)),
    scope: Math.max("SCOPE".length, ...snapshot.runtime.policies.map((p) => runtimeScope(p).length)),
  };
  return (
    <Callout tone="info" title="Runtime policy scope — evaluated before capability policies when scope matches">
      <Text dimColor>
        {"POLICY".padEnd(widths.name)}  {"PHASES".padEnd(widths.phases)}  {"SCOPE".padEnd(widths.scope)}  MATCHES
      </Text>
      {snapshot.runtime.policies.map((policy) => (
        <Box key={policy.name} flexDirection="column">
          <Text>
            <Text color="cyan">{policy.name.padEnd(widths.name)}</Text>
            {"  "}{policy.phases.join(", ").padEnd(widths.phases)}{"  "}
            {runtimeScope(policy).padEnd(widths.scope)}{"  "}
            {policy.capabilities === undefined ? "unknown" : policy.capabilities.length}
          </Text>
          {verbosity === "detail" && policy.capabilities !== undefined ? (
            <Text dimColor>{"  "}candidates {policy.capabilities.join(", ") || "—"}</Text>
          ) : null}
        </Box>
      ))}
      <Box marginTop={1}>
        <Text dimColor>
          A runtime match means the policy can evaluate for that capability; its verdict still
          depends on the surface, actor, input and context of a real invocation.
        </Text>
      </Box>
    </Callout>
  );
}
