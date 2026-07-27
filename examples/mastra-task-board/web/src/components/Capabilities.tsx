import type { CapabilityCard } from "../api";

/**
 * What the model can currently see — the output of the runtime's discovery
 * pipeline (`runtime.describe("aiSdk", …)`), not a hand-maintained list.
 */
export function Capabilities({ caps }: { caps: CapabilityCard[] }) {
  return (
    <section className="card-panel">
      <div className="panel-head">
        <span className="label">What the agent can do</span>
        <span className="count-badge">{caps.length}</span>
      </div>
      <div className="caps-grid">
        {caps.map((cap) => (
          <div className="cap-item" key={cap.id}>
            <div className="id">{cap.id}</div>
            <div className="desc">{cap.description}</div>
            <div className="badges">
              {cap.sideEffect === "destructive" ? (
                <span className="pill danger">
                  <span className="dot" />
                  destructive
                </span>
              ) : (
                <span className="chip-meta">{cap.sideEffect}</span>
              )}
              {cap.risk === "high" || cap.risk === "critical" ? (
                <span className="pill danger">risk: {cap.risk}</span>
              ) : cap.risk === "medium" ? (
                <span className="pill warn">risk: medium</span>
              ) : (
                <span className="chip-meta">risk: low</span>
              )}
              {cap.requiresApproval && (
                <span className="pill warn">
                  <span className="dot" />
                  needs approval
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
