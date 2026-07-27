import type { CapabilityCard } from "../api";

/**
 * What the model can currently see — the output of the runtime's discovery
 * pipeline (`runtime.describe("aiSdk", …)`), not a hand-maintained list.
 */
export function Capabilities({ caps }: { caps: CapabilityCard[] }) {
  return (
    <div className="caps">
      <div className="caps-head">
        <span className="label">What the agent can do</span>
      </div>
      <div className="caps-grid">
        {caps.map((cap) => (
          <div className="cap" key={cap.id}>
            <div className="id">{cap.id}</div>
            <div className="desc">{cap.description}</div>
            <div className="badges">
              <span className={`badge ${cap.sideEffect}`}>{cap.sideEffect}</span>
              <span className={`badge risk-${cap.risk}`}>risk: {cap.risk}</span>
              {cap.requiresApproval && <span className="badge approval">needs approval</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
