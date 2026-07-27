import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { ShieldAlert, Sparkles } from "lucide-react";
import {
  api,
  type ApprovalCard,
  type ChatMessage,
  type Health,
  type Resolution,
  type ToolEvent,
} from "../api";

/**
 * The agent surface. The transcript interleaves messages with the tool-call
 * envelopes the runtime returned — ok / approval-required / error — so the
 * governance layer is visible, not implied. Pending approvals render as
 * cards; deciding one calls decide + resume on the server.
 */

type Entry =
  | { kind: "message"; role: "user" | "assistant"; content: string }
  | { kind: "tools"; events: ToolEvent[] }
  | { kind: "note"; content: string };

export function Chat({
  health,
  approvals,
  onActivity,
}: {
  health: Health | null;
  approvals: ApprovalCard[];
  onActivity: () => void;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [deciding, setDeciding] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [entries, approvals, busy]);

  const aiEnabled = health?.aiEnabled ?? false;

  const send = async () => {
    const content = input.trim();
    if (!content || busy) return;
    setInput("");

    const nextEntries: Entry[] = [...entries, { kind: "message", role: "user", content }];
    setEntries(nextEntries);
    setBusy(true);
    try {
      // The conversation state lives here in the client; each turn sends the
      // full message history (the server holds no chat state).
      const history: ChatMessage[] = nextEntries
        .filter((e): e is Extract<Entry, { kind: "message" }> => e.kind === "message")
        .map(({ role, content: c }) => ({ role, content: c }));
      const response = await api.chat(history);

      const turn: Entry[] = [];
      if (response.toolEvents.length > 0) turn.push({ kind: "tools", events: response.toolEvents });
      turn.push({
        kind: "message",
        role: "assistant",
        content: response.text || "(the agent finished without a reply)",
      });
      setEntries((prev) => [...prev, ...turn]);
    } catch (error) {
      setEntries((prev) => [
        ...prev,
        { kind: "note", content: error instanceof Error ? error.message : String(error) },
      ]);
    } finally {
      setBusy(false);
      onActivity();
    }
  };

  const decide = async (approval: ApprovalCard, approved: boolean) => {
    setDeciding(approval.id);
    try {
      const { resolution } = await api.decide(approval.id, approved);
      setEntries((prev) => [...prev, { kind: "note", content: resolutionLine(approval, resolution) }]);
    } catch (error) {
      setEntries((prev) => [
        ...prev,
        { kind: "note", content: error instanceof Error ? error.message : String(error) },
      ]);
    } finally {
      setDeciding(null);
      onActivity();
    }
  };

  return (
    <aside className="chat">
      <div className="chat-head">
        <span className="ai-chip">
          <Sparkles size={16} />
        </span>
        <div>
          <div className="who">Assistant</div>
          <div className="via">mastra · openrouter{health?.model ? ` · ${health.model}` : ""}</div>
        </div>
      </div>

      <div className="chat-log" ref={logRef}>
        {!aiEnabled && <SetupCard />}
        {aiEnabled && entries.length === 0 && (
          <div className="msg system">
            <div className="bubble">
              Try: “what's on the board?” · “move the flaky test task to done” · “add an urgent
              task to call the datacenter” · “delete the launch announcement task”
            </div>
          </div>
        )}
        {entries.map((entry, i) => (
          <Entry key={i} entry={entry} />
        ))}
        {approvals.map((approval) => (
          <div className="approval" key={approval.id}>
            <div className="kicker">
              <ShieldAlert size={12} />
              Approval required
            </div>
            <div className="body">
              <div className="what">
                {approval.capabilityId}
                {approval.taskTitle ? <> — “{approval.taskTitle}”</> : null}
              </div>
              <div className="reason">{approval.reasons.join("; ")}</div>
              <pre>{JSON.stringify(approval.input, null, 2)}</pre>
              <div className="buttons">
                <button
                  className="approve-btn"
                  disabled={deciding !== null}
                  onClick={() => void decide(approval, true)}
                >
                  Approve &amp; run
                </button>
                <button
                  className="reject-btn"
                  disabled={deciding !== null}
                  onClick={() => void decide(approval, false)}
                >
                  Reject
                </button>
              </div>
            </div>
          </div>
        ))}
        {busy && (
          <div className="thinking" aria-label="The agent is working">
            <i />
            <i />
            <i />
          </div>
        )}
      </div>

      <div className="chat-input">
        <textarea
          placeholder={aiEnabled ? "Ask the assistant…" : "Add an OpenRouter key to enable chat"}
          value={input}
          disabled={!aiEnabled || busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button
          className="btn"
          disabled={!aiEnabled || busy || input.trim().length === 0}
          onClick={() => void send()}
        >
          Send
        </button>
      </div>
    </aside>
  );
}

function Entry({ entry }: { entry: Entry }) {
  if (entry.kind === "message") {
    return (
      <div className={`msg ${entry.role}`}>
        <div className="from">{entry.role === "user" ? "you" : "assistant"}</div>
        {entry.role === "assistant" ? (
          // Model output is markdown; react-markdown escapes raw HTML by
          // default, so untrusted model text cannot inject markup.
          <div className="bubble md">
            <Markdown>{entry.content}</Markdown>
          </div>
        ) : (
          <div className="bubble">{entry.content}</div>
        )}
      </div>
    );
  }
  if (entry.kind === "note") {
    return (
      <div className="msg system">
        <div className="bubble">{entry.content}</div>
      </div>
    );
  }
  return (
    <>
      {entry.events.map((event, i) => (
        <ToolEventLine key={i} event={event} />
      ))}
    </>
  );
}

/** One governed call, envelope and all. */
function ToolEventLine({ event }: { event: ToolEvent }) {
  const status = event.result?.status ?? "error";
  const detail =
    event.result.status === "ok"
      ? null
      : event.result.status === "approval-required"
        ? event.result.message
        : `${event.result.error.code}: ${event.result.error.message}`;
  return (
    <div className={`tool-event ${status}`}>
      <div className="row">
        <span className="name">{event.toolName}</span>
        <span className="args">{JSON.stringify(event.args)}</span>
        <span className="status">→ {status}</span>
      </div>
      {detail && <div>{detail}</div>}
    </div>
  );
}

function resolutionLine(approval: ApprovalCard, resolution: Resolution): string {
  switch (resolution.status) {
    case "completed":
      return `Approved — ${approval.capabilityId} executed: ${JSON.stringify(resolution.output)}`;
    case "rejected":
      return `Rejected — ${approval.capabilityId} was not executed.`;
    case "approval-required":
      return `Still pending (${resolution.approvalId}).`;
    default:
      return `Approved, but execution ${resolution.status}: ${resolution.error.code} — ${resolution.error.message}`;
  }
}

function SetupCard() {
  return (
    <div className="setup">
      <span className="ai-chip">
        <Sparkles size={16} />
      </span>
      <div className="title">AI disabled — bring a key</div>
      <p>
        The board works without it. To enable the assistant, give the example an OpenRouter key
        — any model works, the integration is model-agnostic.
      </p>
      <pre>{`# examples/mastra-task-board/.env
OPENROUTER_API_KEY=sk-or-...
# optional, defaults to anthropic/claude-sonnet-4.5
OPENROUTER_MODEL=anthropic/claude-sonnet-4.5`}</pre>
      <p>
        Then restart <strong>pnpm dev</strong>.
      </p>
      <span className="link">openrouter.ai/keys</span>
    </div>
  );
}
