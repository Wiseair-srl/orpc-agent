import type { CapabilityEntry, CapabilitySnapshot, Change, ChangeKind, EntrySource } from "./types";

/**
 * Plain writes, no rendering framework. This module is what `check` prints on
 * every CI run: keeping it dependency-free keeps the gate's install surface
 * to the package itself.
 */

/**
 * How much of the inventory the human renderers show. `normal` is the table;
 * `min` stops at the headline; `detail` adds each capability's description
 * and declared execution metadata under its row. Shared vocabulary with the
 * sibling `agent-surface` CLI, so the two tools read alike.
 */
export type Verbosity = "min" | "normal" | "detail";

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
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  magenta: "\u001b[35m",
  cyan: "\u001b[36m",
  gray: "\u001b[90m",
};

export function supportsColor(stream: { isTTY?: boolean }): boolean {
  return (
    Boolean(stream.isTTY) && !process.env.CI && !process.env.NO_COLOR && process.env.TERM !== "dumb"
  );
}

function paint(text: string, style: string, mode: ColorMode): string {
  return mode.color ? `${ANSI[style] ?? ""}${text}${ANSI.reset}` : text;
}

/** One hue per fact, mirrored by the Ink view (ui/theme.tsx). */
const RISK_STYLE: Record<string, string> = {
  low: "green",
  medium: "yellow",
  high: "red",
  critical: "magenta",
};

const SIDE_EFFECT_STYLE: Record<string, string> = {
  none: "gray",
  read: "cyan",
  write: "yellow",
  destructive: "red",
  external: "magenta",
};

export function inventoryHeadline(snapshot: CapabilitySnapshot, entrySource: EntrySource): string {
  const exposedCount = snapshot.capabilities.filter((c) => c.expose.length > 0).length;
  const approvalCount = snapshot.capabilities.filter((c) => c.approval?.required).length;
  // The headline is the line that gets pasted somewhere on its own, so it has
  // to carry its own qualification: the count is of DECLARED gates, and whether
  // runtime-level policies were even in scope is part of the headline fact.
  const parts = [
    `${snapshot.capabilities.length} capabilities`,
    `${exposedCount} exposed`,
    `${approvalCount} approval-gated (declared)`,
    runtimeHeadline(snapshot, entrySource),
  ];
  if (snapshot.unexposed.length > 0) parts.push(`${snapshot.unexposed.length} unexposed`);
  if (snapshot.excluded.length > 0) parts.push(`${snapshot.excluded.length} excluded`);
  return parts.join(" · ");
}

/**
 * The declared execution metadata a row has no room for, one dim line per
 * capability under `detail` verbosity. Only present facts are printed.
 */
export function capabilityMeta(capability: CapabilityEntry): string[] {
  const parts: string[] = [];
  if (capability.tags.length > 0) parts.push(capability.tags.map((tag) => `#${tag}`).join(" "));
  if (capability.toolNames && Object.keys(capability.toolNames).length > 0) {
    parts.push(
      `tools ${Object.entries(capability.toolNames)
        .map(([surface, name]) => `${surface}=${name}`)
        .join(", ")}`,
    );
  }
  if (capability.approval?.type) parts.push(`approval type ${capability.approval.type}`);
  if (capability.idempotent) parts.push("idempotent");
  if (capability.retry) parts.push(`retry ×${capability.retry.maxAttempts}`);
  if (capability.timeoutMs !== undefined) parts.push(`timeout ${capability.timeoutMs}ms`);
  if (capability.redact) {
    const redacted = [
      capability.redact.output ? "output" : undefined,
      capability.redact.approvalInput ? "approval input" : undefined,
    ].filter(Boolean);
    if (redacted.length > 0) parts.push(`redacts ${redacted.join(" + ")}`);
  }
  const lines = [capability.description, parts.length > 0 ? parts.join(" · ") : undefined];
  return lines.filter((line): line is string => Boolean(line));
}

export function renderInventory(
  snapshot: CapabilitySnapshot,
  mode: ColorMode,
  entrySource: EntrySource = "registry",
  verbosity: Verbosity = "normal",
): string {
  const lines: string[] = [paint(inventoryHeadline(snapshot, entrySource), "bold", mode)];
  if (verbosity === "min") return lines.join("\n");
  lines.push("");

  const headers = ["CAPABILITY", "SIDE EFFECT", "RISK", "EXPOSE", "APPROVAL", "POLICIES"];
  const rows = snapshot.capabilities.map((capability) => [
    capability.id,
    capability.sideEffect,
    capability.risk,
    capability.expose.join(", ") || "—",
    capability.approval?.required ? "required" : "—",
    capability.policies.join(", ") || "—",
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const cell = (text: string, index: number) =>
    index === headers.length - 1 ? text : text.padEnd(widths[index] ?? 0);
  lines.push(paint(headers.map(cell).join("  ").trimEnd(), "dim", mode));
  snapshot.capabilities.forEach((capability, rowIndex) => {
    const row = rows[rowIndex]!;
    lines.push(
      [
        cell(row[0] ?? "", 0),
        paint(cell(row[1] ?? "", 1), SIDE_EFFECT_STYLE[capability.sideEffect] ?? "", mode),
        paint(cell(row[2] ?? "", 2), RISK_STYLE[capability.risk] ?? "", mode),
        cell(row[3] ?? "", 3),
        paint(cell(row[4] ?? "", 4), capability.approval?.required ? "green" : "dim", mode),
        row[5] === "—" ? paint(cell(row[5] ?? "", 5), "dim", mode) : cell(row[5] ?? "", 5),
      ]
        .join("  ")
        .trimEnd(),
    );
    if (verbosity === "detail") {
      lines.push(...capabilityMeta(capability).map((line) => paint(`  ${line}`, "dim", mode)));
    }
  });
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
        ? "the runtime came from a version of @orpc-agent/core that does not carry its\n" +
          "  governance. Upgrade core to record its policies."
        : "--entry resolved a bare capability registry, which names no policies. If this\n" +
          "  application registers runtime-level policies, those gates are missing from this\n" +
          "  inventory and from the snapshot — deleting one will not fail the gate.\n" +
          "  Declare them with defineGovernance({ registry, policies }) and point --entry at\n" +
          "  that export.";
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

export function renderChanges(changes: Change[], mode: ColorMode, verbosity: Verbosity = "normal"): string {
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

  // The counts are the point of `min`; the rows are the evidence for them.
  if (verbosity === "min") {
    const counts = KIND_ORDER.map(
      (kind) => [kind, changes.filter((c) => c.kind === kind).length] as const,
    )
      .filter(([, count]) => count > 0)
      .map(([kind, count]) => `${kind} ${count}`)
      .join(" · ");
    return [lines[0], counts].join("\n");
  }

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

