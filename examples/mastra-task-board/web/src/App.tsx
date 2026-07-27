import { useCallback, useEffect, useState } from "react";
import {
  api,
  client,
  type ApprovalCard,
  type AuditRow,
  type CapabilityCard,
  type Health,
  type Task,
} from "./api";
import { Board } from "./components/Board";
import { Capabilities } from "./components/Capabilities";
import { Chat } from "./components/Chat";
import { AuditLog } from "./components/AuditLog";

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [caps, setCaps] = useState<CapabilityCard[]>([]);
  const [approvals, setApprovals] = useState<ApprovalCard[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);

  /** One refresh for everything the agent may have changed. */
  const refresh = useCallback(async () => {
    const [nextTasks, nextApprovals, nextAudit] = await Promise.allSettled([
      client.tasks.list({}),
      api.approvals(),
      api.audit(),
    ]);
    if (nextTasks.status === "fulfilled") setTasks(nextTasks.value.tasks);
    if (nextApprovals.status === "fulfilled") setApprovals(nextApprovals.value);
    if (nextAudit.status === "fulfilled") setAudit(nextAudit.value);
  }, []);

  useEffect(() => {
    void api.health().then(setHealth).catch(() => setHealth(null));
    void api.capabilities().then(setCaps).catch(() => setCaps([]));
    void refresh();
    const interval = setInterval(() => void refresh(), 4000);
    return () => clearInterval(interval);
  }, [refresh]);

  return (
    <div className="shell">
      <header className="header">
        <h1>
          task/board <em>×</em> agent
        </h1>
        <span className="stack">orpc-agent governs · mastra runs the loop · openrouter serves the model</span>
        <span className="spacer" />
        <span className={`health ${health?.aiEnabled ? "" : "off"}`}>
          <span className="dot" />
          {health === null ? "server offline" : health.aiEnabled ? health.model : "AI disabled — board still works"}
        </span>
      </header>

      <main className="board">
        <div className="board-top">
          <h2>Board</h2>
        </div>
        <Board tasks={tasks} onChanged={() => void refresh()} />
        <Capabilities caps={caps} />
      </main>

      <Chat health={health} approvals={approvals} onActivity={() => void refresh()} />

      <AuditLog rows={audit} />
    </div>
  );
}
