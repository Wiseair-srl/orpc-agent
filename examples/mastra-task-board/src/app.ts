import {
  createAgentRuntime,
  createCapabilityRegistry,
  createInMemoryApprovalCoordinator,
  type AgentAuditEvent,
} from "@orpc-agent/core";
import {
  DEMO_SESSION,
  actorFrom,
  createAppContext,
  makeServices,
  seedDb,
  type AppContext,
  type Session,
} from "./context";
import { router } from "./capabilities";

/** The same nested structure that serves `/rpc` becomes the governed registry. */
export const capabilities = createCapabilityRegistry(router);

/**
 * Module-scope runtime for `orpc-agent` to read: the serving runtime is built
 * per instance in makeApp(), and a value behind a factory is one the CLI will
 * not call. This app configures no runtime-level policies, and recording that
 * positively — "observed, none" rather than "not observed" — is the point:
 * adding one later shows up as drift.
 */
export const governanceRuntime = createAgentRuntime<AppContext>({
  registry: capabilities,
  warnings: false,
});

/**
 * One assembled application instance: seed data, services, audit trail,
 * approval coordinator, and the governed runtime the Mastra agent runs
 * against. The board UI does not go through the runtime — it calls the
 * procedures as plain oRPC.
 */
export function makeApp(options?: { now?: () => Date }) {
  const now = options?.now ?? (() => new Date());
  const db = seedDb();
  const services = makeServices(db);
  const shared = { db, services, now };

  const auditTrail: AgentAuditEvent[] = [];
  const coordinator = createInMemoryApprovalCoordinator({ now });

  const runtime = createAgentRuntime<AppContext>({
    registry: capabilities,
    approvals: {
      coordinator,
      /**
       * This demo has a single person, who both asks the agent to act and
       * clicks Approve — human-confirmation is requester-confirmed by design,
       * so SI-4's self-approval rejection is deliberately disabled. Keep the
       * default (true) whenever approver and requester are different people.
       */
      rejectSelfApproval: false,
    },
    audit: {
      sinks: [
        (event) => {
          auditTrail.push(event);
        },
      ],
      strict: false,
    },
    now,
  });

  const contextFor = (session: Session): AppContext => createAppContext(session, shared);

  return {
    db,
    services,
    coordinator,
    auditTrail,
    runtime,
    contextFor,
    session: DEMO_SESSION,
    actorFrom,
    now,
  };
}

export type App = ReturnType<typeof makeApp>;
