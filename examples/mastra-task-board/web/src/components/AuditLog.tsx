import type { AuditRow } from "../api";

const TONE: Record<string, "ok" | "warn" | "deny" | ""> = {
  "capability.completed": "ok",
  "capability.approved": "ok",
  "capability.approval_requested": "warn",
  "capability.rejected": "deny",
  "capability.denied": "deny",
  "capability.failed": "deny",
  "capability.cancelled": "deny",
};

/**
 * The flight recorder: every runtime event for agent-originated calls, in
 * order. Events carry classifications and hashes, never raw inputs/outputs.
 */
export function AuditLog({ rows }: { rows: AuditRow[] }) {
  return (
    <section className="card-panel">
      <div className="panel-head">
        <span className="label">Audit ledger</span>
        <span className="hint">agent runtime events — board UI traffic is plain oRPC, not listed</span>
      </div>
      <div className="ledger-rows">
        {rows.length === 0 && (
          <div className="ledger-empty">No agent activity yet — ask the assistant to do something.</div>
        )}
        {[...rows].reverse().map((row, i) => (
          <div className="ledger-line" key={`${row.at}-${i}`}>
            <span className="t">{new Date(row.at).toLocaleTimeString()}</span>
            <span className={`ev ${TONE[row.type] ?? ""}`}>{row.type}</span>
            <span className="cap-id">{row.capabilityId ?? ""}</span>
            <span className="extra">{extra(row)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function extra(row: AuditRow): string {
  const d = row.data;
  switch (row.type) {
    case "capabilities.discovered":
      return `${(d.count as number) ?? 0} capabilities visible`;
    case "capability.denied":
      return `${d.reason} → ${d.publicCode}`;
    case "capability.approval_requested":
      return (d.reasons as string[])?.join("; ") ?? "";
    case "capability.approved":
    case "capability.rejected":
      return `by ${(d.approver as { id?: string })?.id ?? "?"}`;
    case "capability.completed":
      return `${d.durationMs}ms`;
    case "capability.failed":
      return `${d.code} @ ${d.stage}`;
    default:
      return "";
  }
}
