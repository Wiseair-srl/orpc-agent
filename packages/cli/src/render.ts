import type { CapabilitySnapshot, Change, ChangeKind } from "./types";

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

export function renderInventory(snapshot: CapabilitySnapshot, mode: ColorMode): string {
  const lines: string[] = [];
  const exposedCount = snapshot.capabilities.filter((c) => c.expose.length > 0).length;
  const approvalCount = snapshot.capabilities.filter((c) => c.approval?.required).length;

  lines.push(
    paint(
      `${snapshot.capabilities.length} capabilities · ${exposedCount} exposed · ` +
        `${approvalCount} approval-gated`,
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
