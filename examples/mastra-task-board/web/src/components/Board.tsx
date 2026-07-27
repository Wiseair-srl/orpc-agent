import { useState } from "react";
import { client, type Task } from "../api";

const COLUMNS = [
  { key: "todo", label: "Todo" },
  { key: "doing", label: "Doing" },
  { key: "done", label: "Done" },
] as const;

type Status = (typeof COLUMNS)[number]["key"];

/**
 * The human surface. Every action here is a plain typed oRPC call —
 * `client.tasks.*` — hitting the same procedures the agent uses, without the
 * agent governance layer (your middleware still runs).
 */
export function Board({ tasks, onChanged }: { tasks: Task[]; onChanged: () => void }) {
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<"normal" | "urgent">("normal");
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      onChanged();
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const addTask = () => {
    const trimmed = title.trim();
    if (trimmed.length < 3) return;
    void run(async () => {
      await client.tasks.create({ title: trimmed, priority });
      setTitle("");
      setPriority("normal");
    });
  };

  const move = (task: Task, direction: 1 | -1) => {
    const index = COLUMNS.findIndex((c) => c.key === task.status);
    const next = COLUMNS[index + direction];
    if (!next) return;
    void run(() => client.tasks.move({ id: task.id, status: next.key }));
  };

  const remove = (task: Task) => {
    if (!confirm(`Delete "${task.title}"?`)) return;
    void run(() => client.tasks.delete({ id: task.id }));
  };

  return (
    <>
      <form
        className="add-task"
        onSubmit={(e) => {
          e.preventDefault();
          addTask();
        }}
      >
        <input
          type="text"
          placeholder="Add a task…"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={120}
        />
        <select
          value={priority}
          onChange={(e) => setPriority(e.target.value as "normal" | "urgent")}
          aria-label="Priority"
        >
          <option value="normal">normal</option>
          <option value="urgent">urgent</option>
        </select>
        <button className="btn" type="submit" disabled={busy || title.trim().length < 3}>
          Add
        </button>
      </form>

      <div className="columns">
        {COLUMNS.map((column) => {
          const items = tasks.filter((t) => t.status === column.key);
          return (
            <section className="column" key={column.key}>
              <div className="column-head">
                <span className="name">{column.label}</span>
                <span className="count">{items.length}</span>
              </div>
              {items.map((task, i) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  index={i}
                  onMove={(dir) => move(task, dir)}
                  onDelete={() => remove(task)}
                  status={column.key}
                />
              ))}
            </section>
          );
        })}
      </div>
    </>
  );
}

function TaskCard({
  task,
  index,
  status,
  onMove,
  onDelete,
}: {
  task: Task;
  index: number;
  status: Status;
  onMove: (direction: 1 | -1) => void;
  onDelete: () => void;
}) {
  return (
    <article className="card" style={{ animationDelay: `${index * 40}ms` }}>
      <div className="actions">
        {status !== "todo" && (
          <button className="icon-btn" title="Move left" onClick={() => onMove(-1)}>
            ←
          </button>
        )}
        {status !== "done" && (
          <button className="icon-btn" title="Move right" onClick={() => onMove(1)}>
            →
          </button>
        )}
        <button className="icon-btn danger" title="Delete" onClick={onDelete}>
          ✕
        </button>
      </div>
      <div className="title">{task.title}</div>
      <div className="meta">
        {task.priority === "urgent" && <span className="tag urgent">urgent</span>}
        {task.createdBy === "agent" && <span className="tag agent-made">by agent</span>}
        {task.notes && (
          <span className="tag notes" title={`${task.notes}\n\n(You can read this. The model cannot — tasks.list redacts notes before output reaches it.)`}>
            ⌀ notes · hidden from model
          </span>
        )}
      </div>
    </article>
  );
}
