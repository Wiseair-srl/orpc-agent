import React, { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { snapshotJson } from "../canonical";
import { addScript, hasScript, writeAgentConfig, type AgentConfig } from "../discover";
import { LoadError, loadSnapshot } from "../load";
import type { CapabilitySnapshot, EntrySource } from "../types";
import { Callout, Spinner } from "./theme";
import { Confirm, Select, type Choice } from "./Select";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * `orpc-agent init` — picks the entry and export, then writes the config so
 * the CI step reduces to `orpc-agent check`.
 *
 * The wizard loads candidates through the same child-process loader every
 * other command uses, so what it reports is what `check` will see. It writes
 * nothing until the summary has been shown and confirmed.
 */

type Probe = {
  snapshot: CapabilitySnapshot;
  entrySource: EntrySource;
  runtimeAvailableAs?: string;
};

type Step =
  | { name: "pick-entry" }
  | { name: "probing"; entry: string; exportName?: string }
  | { name: "failed"; entry: string; message: string; detail?: string }
  | { name: "review"; entry: string; exportName?: string; probe: Probe }
  | { name: "confirm-snapshot"; config: AgentConfig; probe: Probe; written: string }
  | { name: "done"; config: AgentConfig; probe: Probe; written: string; snapshotPath?: string };

export function Init({
  cwd,
  candidates,
  snapshotPath,
  onExit,
}: {
  cwd: string;
  candidates: string[];
  snapshotPath: string;
  onExit: (code: number) => void;
}) {
  const { exit } = useApp();
  const [step, setStep] = useState<Step>(
    candidates.length === 1
      ? { name: "probing", entry: candidates[0]! }
      : { name: "pick-entry" },
  );

  useEffect(() => {
    if (step.name !== "probing") return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await loadSnapshot({
          entry: step.entry,
          ...(step.exportName ? { exportName: step.exportName } : {}),
          cwd,
        });
        if (cancelled) return;
        setStep({
          name: "review",
          entry: step.entry,
          ...(step.exportName ? { exportName: step.exportName } : {}),
          probe: result,
        });
      } catch (error) {
        if (cancelled) return;
        setStep({
          name: "failed",
          entry: step.entry,
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof LoadError && error.detail ? { detail: error.detail } : {}),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step, cwd]);

  if (step.name === "pick-entry") {
    const choices: Choice<string>[] = candidates.map((candidate, index) => ({
      value: candidate,
      label: candidate,
      ...(index === 0 ? { recommended: true } : {}),
    }));
    return (
      <Box flexDirection="column">
        <Text bold>Which module assembles your application?</Text>
        <Box marginTop={1}>
          <Select
            choices={choices}
            onSubmit={(entry) => setStep({ name: "probing", entry })}
          />
        </Box>
      </Box>
    );
  }

  if (step.name === "probing") {
    return <Spinner label={`loading ${step.entry}…`} />;
  }

  if (step.name === "failed") {
    return (
      <Box flexDirection="column">
        <Callout tone="danger" title={`Could not read ${step.entry}`}>
          <Text>{step.message}</Text>
          {step.detail && <Text dimColor>{step.detail}</Text>}
        </Callout>
        <Box marginTop={1}>
          <Text dimColor>Fix the entry, or re-run with --entry &lt;path&gt;.</Text>
        </Box>
        <Exiter code={2} exit={exit} onExit={onExit} />
      </Box>
    );
  }

  if (step.name === "review") {
    // The loader reports when the chosen export was a registry while a runtime
    // over it exists. Offer that instead of silently recording less.
    if (step.probe.runtimeAvailableAs) {
      return (
        <Box flexDirection="column">
          <Callout tone="warn" title="A governed export is available on this module">
            <Text>
              Reading the bare registry records no runtime-level policies. Export{" "}
              <Text color="cyan">{step.probe.runtimeAvailableAs}</Text> carries the governance
              over the same registry.
            </Text>
          </Callout>
          <Box marginTop={1}>
            <Select
              choices={[
                {
                  value: step.probe.runtimeAvailableAs,
                  label: `use ${step.probe.runtimeAvailableAs}`,
                  hint: "records runtime-level policies",
                  recommended: true,
                },
                { value: "", label: "keep the registry", hint: "policies stay unobserved" },
              ]}
              onSubmit={(chosen) =>
                setStep(
                  chosen
                    ? { name: "probing", entry: step.entry, exportName: chosen }
                    : {
                        name: "review",
                        entry: step.entry,
                        probe: { ...step.probe, runtimeAvailableAs: undefined },
                      },
                )
              }
            />
          </Box>
        </Box>
      );
    }

    return (
      <Box flexDirection="column">
        <Findings probe={step.probe} entry={step.entry} exportName={step.exportName} />
        <Box marginTop={1}>
          <Confirm
            label="Write this to package.json?"
            onSubmit={(yes) => {
              if (!yes) {
                onExit(0);
                exit();
                return;
              }
              const config: AgentConfig = {
                entry: step.entry,
                ...(step.exportName ? { export: step.exportName } : {}),
              };
              const written = writeAgentConfig(cwd, config);
              setStep({ name: "confirm-snapshot", config, probe: step.probe, written });
            }}
          />
        </Box>
      </Box>
    );
  }

  if (step.name === "confirm-snapshot") {
    return (
      <Box flexDirection="column">
        <Text color="green">✓ wrote {step.written}</Text>
        <Box marginTop={1}>
          <Confirm
            label={`Write the baseline snapshot to ${snapshotPath}?`}
            onSubmit={(yes) => {
              let written: string | undefined;
              if (yes) {
                writeFileSync(resolve(cwd, snapshotPath), snapshotJson(step.probe.snapshot));
                written = snapshotPath;
                if (!hasScript(cwd, "check:capabilities")) {
                  addScript(cwd, "check:capabilities", "orpc-agent check");
                }
              }
              setStep({
                name: "done",
                config: step.config,
                probe: step.probe,
                written: step.written,
                ...(written ? { snapshotPath: written } : {}),
              });
            }}
          />
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color="green">✓ wrote {step.written}</Text>
      {step.snapshotPath && (
        <>
          <Text color="green">✓ wrote {step.snapshotPath}</Text>
          <Text color="green">✓ added the check:capabilities script</Text>
        </>
      )}
      <Box marginTop={1} flexDirection="column">
        <Text bold>Next</Text>
        {!step.snapshotPath && (
          <Text>
            {"  "}
            <Text color="cyan">orpc-agent snapshot</Text>
            <Text dimColor>{"   "}commit the baseline</Text>
          </Text>
        )}
        <Text>
          {"  "}
          <Text color="cyan">orpc-agent check</Text>
          <Text dimColor>{"      "}fails on drift · 0 clean, 1 drift, 2 could not run</Text>
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>In CI:</Text>
        <Text dimColor>{"  "}- run: npx orpc-agent check --format github</Text>
      </Box>
      {!step.probe.snapshot.runtime && (
        <Callout tone="warn" title="Runtime policies are not covered">
          <Text>
            This entry resolves a capability registry. If the application registers
            runtime-level policies, deleting one will not fail this gate.
          </Text>
        </Callout>
      )}
      <Exiter code={0} exit={exit} onExit={onExit} />
    </Box>
  );
}

/** Ink needs the exit to happen after paint, not during render. */
function Exiter({
  code,
  exit,
  onExit,
}: {
  code: number;
  exit: () => void;
  onExit: (code: number) => void;
}) {
  useEffect(() => {
    const timer = setTimeout(() => {
      onExit(code);
      exit();
    }, 10);
    return () => clearTimeout(timer);
  }, [code, exit, onExit]);
  return null;
}

function Findings({
  probe,
  entry,
  exportName,
}: {
  probe: Probe;
  entry: string;
  exportName?: string;
}) {
  const { snapshot } = probe;
  const exposed = snapshot.capabilities.filter((c) => c.expose.length > 0).length;
  const gated = snapshot.capabilities.filter((c) => c.approval?.required).length;

  return (
    <Box flexDirection="column">
      <Text bold>Found in {entry}</Text>
      {exportName && (
        <Text dimColor>
          {"  "}export {exportName}
        </Text>
      )}
      <Box marginTop={1} flexDirection="column">
        <Row label="capabilities" value={`${snapshot.capabilities.length}`} />
        <Row label="exposed" value={`${exposed}`} />
        <Row label="approval-gated" value={`${gated}`} hint="declared in meta.approval" />
        <Row
          label="runtime policies"
          value={
            snapshot.runtime
              ? snapshot.runtime.policies.length === 0
                ? "none"
                : snapshot.runtime.policies.map((p) => p.name).join(", ")
              : "not observed"
          }
          hint={snapshot.runtime ? undefined : "no runtime in scope"}
          tone={snapshot.runtime ? "ok" : "warn"}
        />
      </Box>
    </Box>
  );
}

function Row({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "ok" | "warn";
}) {
  return (
    <Box>
      <Text dimColor>{`  ${label}`.padEnd(22)}</Text>
      <Text color={tone === "warn" ? "yellow" : undefined}>{value}</Text>
      {hint && <Text dimColor>{"  "}{hint}</Text>}
    </Box>
  );
}
