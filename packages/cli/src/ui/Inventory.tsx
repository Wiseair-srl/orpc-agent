import React from "react";
import { Box, Text } from "ink";
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
}: {
  snapshot: CapabilitySnapshot;
  entrySource: EntrySource;
}) {
  const exposed = snapshot.capabilities.filter((c) => c.expose.length > 0).length;
  const gated = snapshot.capabilities.filter((c) => c.approval?.required).length;
  const observed = snapshot.runtime !== undefined;

  const widths = {
    id: Math.max(10, ...snapshot.capabilities.map((c) => c.id.length)),
    effect: 11,
    risk: 8,
    expose: Math.max(6, ...snapshot.capabilities.map((c) => c.expose.join(", ").length)),
    approval: 8,
  };

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>{snapshot.capabilities.length} capabilities</Text>
        <Text dimColor> · </Text>
        <Text bold>{exposed} exposed</Text>
        <Text dimColor> · </Text>
        <Text bold color={gated > 0 ? "green" : undefined}>
          {gated} approval-gated
        </Text>
        <Text dimColor> (declared) · </Text>
        {observed ? (
          <Text bold color={snapshot.runtime!.policies.length > 0 ? "cyan" : undefined}>
            {snapshot.runtime!.policies.length === 0
              ? "no runtime policies"
              : `${snapshot.runtime!.policies.length} runtime ${
                  snapshot.runtime!.policies.length === 1 ? "policy" : "policies"
                }`}
          </Text>
        ) : (
          <Text bold color="yellow">
            runtime policies not observed
          </Text>
        )}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          {"CAPABILITY".padEnd(widths.id)}  {"SIDE EFFECT".padEnd(widths.effect)}{" "}
          {"RISK".padEnd(widths.risk)} {"EXPOSE".padEnd(widths.expose)}{" "}
          {"APPROVAL".padEnd(widths.approval)} POLICIES
        </Text>
      </Box>
      {snapshot.capabilities.map((capability) => (
        <Box key={capability.id}>
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
          <Text dimColor={capability.policies.length === 0}>
            {capability.policies.join(", ") || "—"}
          </Text>
        </Box>
      ))}

      <RuntimePanel snapshot={snapshot} entrySource={entrySource} />

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
    </Box>
  );
}

function RuntimePanel({
  snapshot,
  entrySource,
}: {
  snapshot: CapabilitySnapshot;
  entrySource: EntrySource;
}) {
  if (!snapshot.runtime) {
    return (
      <Callout tone="warn" title="Runtime policies — NOT OBSERVED">
        {entrySource === "runtime-unreported" ? (
          <Text>
            The runtime came from a version of @orpc-agent/core that does not report its
            policies. Upgrade core to record them.
          </Text>
        ) : (
          <Text>
            <Text>--entry resolved a capability registry, so a runtime was never in scope. If</Text>
            <Text> this application calls </Text>
            <Text color="cyan">createAgentRuntime(&#123; policies: … &#125;)</Text>
            <Text>, those gates are missing from this inventory and from the snapshot.</Text>
            <Text bold> Point --entry at the module that exports the runtime.</Text>
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

  const width = Math.max(...snapshot.runtime.policies.map((p) => p.name.length));
  return (
    <Callout tone="info" title="Runtime policies — evaluated on every invocation, before capability policies">
      {snapshot.runtime.policies.map((policy) => (
        <Box key={policy.name}>
          <Text color="cyan">{policy.name.padEnd(width)}</Text>
          <Text dimColor>{"  "}{policy.phases.join(", ")}</Text>
        </Box>
      ))}
      <Box marginTop={1}>
        <Text dimColor>
          The APPROVAL and POLICIES columns are per-capability declarations. A runtime policy
          can require approval, deny, or hide conditionally — on surface, actor, input or
          context. Which capabilities these affect, and when, is not knowable without
          evaluating them against a real invocation, which this tool never does.
        </Text>
      </Box>
    </Callout>
  );
}
