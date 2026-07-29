import {
  createAgentRuntime,
  createCapabilityRegistry,
  createInMemoryApprovalCoordinator,
  type AgentAuditEvent,
  type ApprovalDecision,
  type ApprovalRequest,
  type TracingAdapter,
} from "@orpc-agent/core";
import { testClock, type TestClock } from "@orpc-agent/testing";
import {
  SESSIONS,
  actorFrom,
  createAppContext,
  makeServices,
  seedDb,
  type AppContext,
  type Session,
} from "./context";
import {
  checkRefundEligibility,
  draftMessage,
  escalateCase,
  getCustomer,
  getCustomerThread,
  getOrder,
  listOrders,
  refundOrder,
  searchCustomers,
  sendMessage,
} from "./capabilities";
import { mcpReadOnly, orgIsolation } from "./policies";

export const capabilities = createCapabilityRegistry({
  customers: { search: searchCustomers, get: getCustomer },
  orders: { list: listOrders, get: getOrder, checkRefundEligibility, refund: refundOrder },
  messages: { draft: draftMessage, send: sendMessage, getCustomerThread },
  cases: { escalate: escalateCase },
});

/**
 * The governance configuration every runtime this app builds starts from.
 * One constant, spread into each instance below, so there is exactly one
 * place where the runtime-level policy list is written down.
 */
const GOVERNANCE = {
  registry: capabilities,
  policies: [orgIsolation, mcpReadOnly],
};

/**
 * The same governance, at module scope, for `orpc-agent` to read.
 *
 * The runtimes that serve traffic are built per instance inside makeApp()
 * (they need the seeded db's audit sink and the injected clock), and a value
 * behind a factory is one the CLI will not call. Constructing a runtime is
 * pure and does no I/O, so exporting one costs nothing — and because it
 * spreads GOVERNANCE, it cannot report a policy list the real runtimes do not
 * use. Without it the snapshot would record org-isolation and mcp-read-only
 * as "not observed", and deleting either would pass CI.
 */
export const governanceRuntime = createAgentRuntime<AppContext>({
  ...GOVERNANCE,
  warnings: false,
});

/**
 * One assembled application instance: seed data, services, shared audit
 * store, coordinator, and the two runtime configurations over one registry —
 * the main runtime (coordinator/resume flow, used by the dashboard, workers,
 * and MCP) and the chat runtime (inline human-confirmation for messages.send;
 * everything else defers to the coordinator).
 */
export function makeApp(options?: { tracing?: TracingAdapter; clock?: TestClock }) {
  const clock = options?.clock ?? testClock("2026-07-27T10:00:00Z");
  const db = seedDb();
  const services = makeServices(db);
  const shared = { db, services, now: clock.now };

  const auditTrail: AgentAuditEvent[] = [];
  const dbAuditSink = (event: AgentAuditEvent) => {
    auditTrail.push(event);
    db.auditRows.push(event);
  };

  const coordinator = createInMemoryApprovalCoordinator({ now: clock.now });

  const runtimeConfig = {
    ...GOVERNANCE,
    audit: { sinks: [dbAuditSink], strict: false },
    now: clock.now,
    ...(options?.tracing ? { tracing: options.tracing } : {}),
  };

  /** Coordinator mode: refunds suspend for the approvals dashboard. */
  const runtime = createAgentRuntime<AppContext>({
    ...runtimeConfig,
    approvals: { coordinator },
  });

  /**
   * Chat UI variant: `messages.send` confirms inline (the human is present,
   * on the button); other approval types defer to the coordinator flow.
   * rejectSelfApproval is disabled HERE ONLY because human-confirmation is
   * requester-confirmed by design; manager approvals still resolve on the
   * main runtime, where the default (true) stays enforced at resume.
   */
  const ui: {
    /** The scripted "Send" button. Tests/demo replace per scenario. */
    confirmSend: (
      req: ApprovalRequest,
      session: Session,
    ) => Promise<ApprovalDecision | undefined>;
  } = {
    confirmSend: async (_req, session) => ({
      status: "approved",
      approver: actorFrom(session),
    }),
  };

  const chatRuntimeFor = (session: Session) =>
    createAgentRuntime<AppContext>({
      ...runtimeConfig,
      approvals: {
        coordinator,
        handler: async (req) =>
          req.types.includes("human-confirmation") ? ui.confirmSend(req, session) : undefined,
        rejectSelfApproval: false,
      },
    });

  const contextFor = (session: Session): AppContext => createAppContext(session, shared);

  return {
    db,
    services,
    clock,
    coordinator,
    auditTrail,
    runtime,
    chatRuntimeFor,
    ui,
    contextFor,
    sessions: SESSIONS,
    actorFrom,
  };
}

export type App = ReturnType<typeof makeApp>;
