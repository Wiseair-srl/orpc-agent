import type { CapabilitySnapshot, Change, ChangeKind, EntrySource } from "./types";

/**
 * Plain writes, no rendering framework. This module is what `check` prints on
 * every CI run: keeping it dependency-free keeps the gate's install surface
 * to the package itself.
 */

const KIND_ORDER: ChangeKind[] = ["widening", "narrowing", "neutral"];

const KIND_LABEL: Record<ChangeKind, string> = {
  widening: "WIDENING — the agent gained reach, or a control weakened",
  narrowing: "NARROWING — reach or capability removed",
  neutral: "NEUTRAL — contract changes worth reading",
};

export type ColorMode = { color: boolean };

const ANSI: Record<string, string> = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  bold: "\u001b[1m",
  red: "\u001b[31m",
  cyan: "\u001b[36m",
};

export function supportsColor(stream: { isTTY?: boolean }): boolean {
  return Boolean(stream.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";
}

function paint(text: string, style: string, mode: ColorMode): string {
  return mode.color ? `${ANSI[style] ?? ""}${text}${ANSI.reset}` : text;
}

export function renderInventory(
  snapshot: CapabilitySnapshot,
  mode: ColorMode,
  entrySource: EntrySource = "registry",
): string {
  const lines: string[] = [];
  const exposedCount = snapshot.capabilities.filter((c) => c.expose.length > 0).length;
  const approvalCount = snapshot.capabilities.filter((c) => c.approval?.required).length;

  // The header is the line that gets pasted somewhere on its own, so it has to
  // carry its own qualification: the count is of DECLARED gates, and whether
  // runtime-level policies were even in scope is part of the headline fact.
  lines.push(
    paint(
      `${snapshot.capabilities.length} capabilities · ${exposedCount} exposed · ` +
        `${approvalCount} approval-gated (declared) · ${runtimeHeadline(snapshot, entrySource)}`,
      "bold",
      mode,
    ),
    "",
  );

  const rows = snapshot.capabilities.map((capability) => [
    capability.id,
    capability.sideEffect,
    capability.risk,
    capability.expose.join(", ") || "—",
    capability.approval?.required ? "required" : "—",
    capability.policies.join(", ") || "—",
  ]);
  lines.push(...table(["CAPABILITY", "SIDE EFFECT", "RISK", "EXPOSE", "APPROVAL", "POLICIES"], rows, mode));
  lines.push("", ...renderRuntimeSection(snapshot, entrySource, mode));

  if (snapshot.unexposed.length > 0) {
    lines.push(
      "",
      paint("Defined, reachable nowhere", "bold", mode),
      ...snapshot.unexposed.map((id) => `  ${id}`),
    );
  }
  if (snapshot.excluded.length > 0) {
    lines.push(
      "",
      paint("Excluded — no meta.agent, on no surface", "bold", mode),
      ...snapshot.excluded.map((path) => `  ${path}`),
    );
  }
  return lines.join("\n");
}

function runtimeHeadline(snapshot: CapabilitySnapshot, entrySource: EntrySource): string {
  if (!snapshot.runtime) return "runtime policies not observed";
  const count = snapshot.runtime.policies.length;
  if (count === 0) return "no runtime policies";
  return `${count} runtime ${count === 1 ? "policy" : "policies"}`;
}

/**
 * The blind spot, stated in the output rather than only in the README. The
 * columns above are declarations; a runtime policy can add approval, denial or
 * hiding conditionally, and nothing static can say to which capabilities.
 */
function renderRuntimeSection(
  snapshot: CapabilitySnapshot,
  entrySource: EntrySource,
  mode: ColorMode,
): string[] {
  if (!snapshot.runtime) {
    const why =
      entrySource === "runtime-unreported"
        ? "the runtime came from a version of @orpc-agent/core that does not report its\n" +
          "  policies. Upgrade core to record them."
        : "--entry resolved a capability registry, so a runtime was never in scope. If this\n" +
          "  application calls createAgentRuntime({ policies: … }), those gates are missing\n" +
          "  from this inventory and from the snapshot. Point --entry at the module that\n" +
          "  exports the runtime to record them.";
    return [
      paint("Runtime policies — NOT OBSERVED", "bold", mode),
      `  ${why}`,
    ];
  }

  if (snapshot.runtime.policies.length === 0) {
    return [paint("Runtime policies — none configured", "bold", mode)];
  }

  return [
    paint("Runtime policies — evaluated on every invocation, before capability policies", "bold", mode),
    ...snapshot.runtime.policies.map((policy) => `  ${policy.name}  ${policy.phases.join(", ")}`),
    "",
    paint(
      "  The APPROVAL and POLICIES columns above are per-capability declarations. A runtime\n" +
        "  policy can require approval, deny, or hide conditionally — on surface, actor, input\n" +
        "  or context. Which capabilities these affect, and when, is not knowable without\n" +
        "  evaluating them against a real invocation, which this tool never does.",
      "dim",
      mode,
    ),
  ];
}

export function renderChanges(changes: Change[], mode: ColorMode): string {
  if (changes.length === 0) return paint("No capability drift.", "bold", mode);

  const widening = changes.filter((c) => c.kind === "widening").length;
  const lines: string[] = [
    paint(
      `Capability drift — ${changes.length} change${changes.length === 1 ? "" : "s"}` +
        (widening > 0 ? `, ${widening} widening` : ""),
      "bold",
      mode,
    ),
  ];

  for (const kind of KIND_ORDER) {
    const group = changes.filter((c) => c.kind === kind);
    if (group.length === 0) continue;
    const style = kind === "widening" ? "red" : kind === "narrowing" ? "cyan" : "dim";
    lines.push("", paint(KIND_LABEL[kind], style, mode));
    const idWidth = Math.max(...group.map((c) => c.id.length));
    const fieldWidth = Math.max(...group.map((c) => c.field.length));
    for (const item of group) {
      const field = paint(item.field.padEnd(fieldWidth), "dim", mode);
      lines.push(`  ${item.id.padEnd(idWidth)}  ${field}  ${item.message}`);
    }
  }
  return lines.join("\n");
}

/** GitHub Actions annotations — widening as errors, everything else quieter. */
export function renderGithub(changes: Change[]): string {
  return changes
    .map((change) => {
      const level =
        change.kind === "widening" ? "error" : change.kind === "narrowing" ? "warning" : "notice";
      const title = `${change.kind}: ${change.id} (${change.field})`;
      return `::${level} title=${escapeAnnotation(title)}::${escapeAnnotation(
        `${change.id} — ${change.message}`,
      )}`;
    })
    .join("\n");
}

export function renderMarkdown(changes: Change[]): string {
  if (changes.length === 0) return "**No capability drift.**";
  const emoji: Record<ChangeKind, string> = {
    widening: "🔴",
    narrowing: "🔵",
    neutral: "⚪️",
  };
  const lines = [
    `**Capability drift — ${changes.length} change${changes.length === 1 ? "" : "s"}**`,
    "",
    "| | Capability | Field | Change |",
    "| --- | --- | --- | --- |",
  ];
  for (const kind of KIND_ORDER) {
    for (const change of changes.filter((c) => c.kind === kind)) {
      lines.push(
        `| ${emoji[kind]} | \`${change.id}\` | ${change.field} | ${escapePipes(change.message)} |`,
      );
    }
  }
  return lines.join("\n");
}

function escapeAnnotation(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/::/g, ":");
}

function escapePipes(text: string): string {
  return text.replace(/\|/g, "\\|");
}

function table(headers: string[], rows: string[][], mode: ColorMode): string[] {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, index) => (index === cells.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
      .join("  ")
      .trimEnd();
  return [paint(line(headers), "dim", mode), ...rows.map(line)];
}
