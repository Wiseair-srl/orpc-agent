import { useCallback, useEffect, useState } from "react";
import {
  Check,
  ChevronRight,
  CircleHelp,
  ClipboardList,
  History,
  LayoutDashboard,
  MessageSquare,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
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

  const open = tasks.filter((t) => t.status !== "done").length;
  const done = tasks.filter((t) => t.status === "done").length;

  return (
    <div className="shell">
      <Rail />

      <main className="main">
        <div className="page-head">
          <div>
            <div className="crumbs">
              <span>orpc-agent</span>
              <ChevronRight size={11} />
              <span>examples</span>
              <ChevronRight size={11} />
              <span className="here">Task board</span>
            </div>
            <h1>Task board</h1>
            <div className="sub">
              Four governed capabilities, two clients — the board UI and a Mastra agent.
            </div>
          </div>
          <HealthPill health={health} />
        </div>

        <div className="stats">
          <Stat icon={<ClipboardList size={16} />} value={open} label="Open tasks" />
          <Stat icon={<Check size={16} />} value={done} label="Done" />
          <Stat icon={<ShieldAlert size={16} />} value={approvals.length} label="Pending approvals" />
          <Stat icon={<Sparkles size={16} />} value={audit.length} label="Agent runtime events" />
        </div>

        <Board tasks={tasks} onChanged={() => void refresh()} />
        <Capabilities caps={caps} />
        <AuditLog rows={audit} />
        <div className="page-end" />
      </main>

      <Chat health={health} approvals={approvals} onActivity={() => void refresh()} />
    </div>
  );
}

function Rail() {
  return (
    <nav className="rail">
      <div className="logo">T</div>
      <div className="items">
        <span className="item active" title="Board">
          <LayoutDashboard size={16} />
        </span>
        <span className="item" title="Assistant">
          <MessageSquare size={16} />
        </span>
        <span className="item" title="Audit">
          <History size={16} />
        </span>
      </div>
      <div className="foot">
        <CircleHelp size={16} />
        <div className="avatar">YO</div>
      </div>
    </nav>
  );
}

function Stat({ icon, value, label }: { icon: React.ReactNode; value: number; label: string }) {
  return (
    <div className="stat">
      <div className="chip">{icon}</div>
      <div>
        <div className="value">{value}</div>
        <div className="label">{label}</div>
      </div>
    </div>
  );
}

function HealthPill({ health }: { health: Health | null }) {
  if (health === null) {
    return (
      <span className="pill danger">
        <span className="dot" />
        server offline
      </span>
    );
  }
  if (!health.aiEnabled) {
    return (
      <span className="pill warn">
        <span className="dot" />
        AI disabled — board still works
      </span>
    );
  }
  return (
    <span className="pill ok">
      <span className="dot" />
      {health.model}
    </span>
  );
}
