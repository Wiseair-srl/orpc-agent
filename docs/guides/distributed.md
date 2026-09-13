# Distributed capability runtimes

Run domain procedures in stateless HTTP handlers and the agent loop in a separate long-lived host. The backend remains the sole governance authority. The host imports contracts and clients; it does not wrap raw RPC proxies in a second governing runtime.

## Backend gateway

```ts
import { createAgentRuntime } from "@orpc-agent/core";
import { createCapabilityGateway } from "@orpc-agent/core/server";
import { registerZodSchemaConverter } from "@orpc-agent/core/schema/zod";
import { createPgApprovalCoordinator, createPgAuditSink, createPgInvocationJournal } from "@orpc-agent/postgres";

registerZodSchemaConverter(); // Before constructing governance's registry.
// governance and query are application-owned immutable registry/pool references.
const approvals = createPgApprovalCoordinator({ query });
const journal = createPgInvocationJournal({ query });
const gateway = createCapabilityGateway({
  surface: "aiSdk", // Fixed by this route; never a client input.
  revision: "deployment-contract-revision",
  journal,
  authenticate: async (requestContext: RequestContext) => {
    const session = await verifySession(requestContext.headers);
    return { actor: session.actor, namespace: session.organizationId, context: session.domainContext };
  },
  authorize: async ({ principal, operation, capabilityId, input }) => {
    await authorizeCapabilityAccess(principal, operation, capabilityId, input);
  },
  createRuntime: () => createAgentRuntime({
    governance,
    approvals: { coordinator: approvals },
    audit: { sinks: [createPgAuditSink({ query })], strict: true },
  }),
  requestTimeoutMs: 25_000,
  auditDrainTimeoutMs: 5_000,
});
// Mount gateway with the application's ordinary oRPC RPCHandler.
```

Apply `APPROVALS_DDL`, `AUDIT_DDL`, and `INVOCATIONS_DDL` through application migrations. Existing governance, session verification and domain authorization remain application-owned. `authenticate` executes for every call; it must reject expired/invalid credentials. `namespace` comes from trusted session/application state and includes every tenant/application partition relevant to authority. Anonymous actors are rejected.

`authorize` is required and must throw on denial. It runs for discovery, invocation, receipt lookup, approval lookup, and resumption. For receipt/approval reads it receives the original private JSON input, enabling current resource authorization. A missing record has no capability/input; return no information about another actor's records. Factor audience, role, MFA and resource checks into shared authorization usable here and in ordinary procedures. Discovery alone does not execute procedure middleware. Do not treat an actor-shaped object as proof of permissions.

Share immutable governance and database pools between warm requests, but create a runtime/emitter per request. The gateway forwards oRPC cancellation and reserves audit-drain time inside the total request ceiling. Timeouts bound the response; JavaScript cannot force an uncooperative handler or external effect to stop. Keep handler/dependency deadlines below the request ceiling and isolate gateway initialization failures from ordinary RPC routes.

## Host client

```ts
import { createHttpCapabilityClient } from "@orpc-agent/core/http";
import { toAISDKTools } from "@orpc-agent/ai-sdk";

const client = createHttpCapabilityClient({
  url: "https://api.example.com/capabilities",
  headers: async () => ({ authorization: `Bearer ${await freshCredential()}` }),
});
const tools = await toAISDKTools(client, {
  scope: { tags: ["support"] },
  correlationId: runId,
  invocationId: async ({ capabilityId, input, toolCallId }) =>
    callStore.reserve({ runId, toolCallId, capabilityId, input }),
});
```

`HttpCapabilityClientOptions` is the native RPCLink options type, including authenticated headers/custom fetch. `createCapabilityClient({ rpc })` accepts an already-created structural `CapabilityRPCClient`, so the application can use its existing oRPC transport. The `core/client` entry imports no server implementation, schema library or Node runtime code. Authenticate separately on every resumed request; never store bearer tokens in prompts or traces.

## Portable contract

`exportCapabilityContract(governance, revision)` in `core/server` produces `PortableCapabilityDescriptor[]`. Each descriptor includes `version: 1`, canonical `id`, original `path`, description, full JSON input schema, side effect, risk, tags, approval hint, `discovery`, resolved `toolNames: { aiSdk, mcp }`, and `contractDigest`. Handlers, credentials, executable policy functions and domain context are excluded. Model output schemas are omitted because redaction may change the ordinary procedure output shape.

The digest includes static metadata, exposure, governance manifest and the application revision. Change revision when handler/policy meaning changes, even if its schema is identical. Digests detect incompatible deployments; they grant no permissions. Static artifacts may be cached by release. `client.describe({ scope? })` applies the authenticated actor's discovery policies first; never cache its result across actors. Contextual entries remain callable on their configured agent exposure while a browser supplies their bound presentation.

Remote inputs must be JSON values; dates must be ISO strings in input schemas. Undefined input is allowed for procedures with no input. Completed outputs support JSON plus `Date` values (converted to ISO strings); undefined object properties are omitted and top-level undefined becomes null. Cycles, non-finite numbers, unsupported object prototypes and accessors are rejected. A conversion failure after execution leaves an unknown receipt; it does not prove the effect failed. Persisted approval inputs remain subject to the approval coordinator's JSON/hash integrity contract.

## Client operations and results

| Operation | Contract |
| --- | --- |
| `describe({ scope? }?)` | Actor-filtered portable descriptors |
| `invoke(capabilityId, input, options)` | Governed execution with stable invocation identity |
| `getInvocation(invocationId)` | Authorized `InvocationReceipt` or null |
| `getApproval(approvalId)` | Authorized `PortableApproval` or null |
| `resumeApproval(approvalId, options)` | Continue the original invocation using its original ID |

`InvocationOptions` contains required `invocationId` plus optional `correlationId`, `contractDigest`, and `signal`. IDs are bounded to 256 characters. Scope accepts at most 1,000 tags/IDs of at most 256 characters. Unknown request fields are rejected. Client input cannot choose actor, namespace, context or surface.

`CapabilityOutcome` always carries `invocationId`. Its variants are `completed` with `executionId`/`output`, `approval-required` with `executionId`/`approval`, `failed` or `cancelled` with `executionId`/safe `error`, and `outcome-unknown`. Preflight failures use an empty execution ID because no core execution was admitted. Public errors have `code`, `message`, `retryable`, and optional input-validation details; private causes/stages never cross the boundary. Gateway codes add `INVOCATION_CONFLICT` and `CONTRACT_MISMATCH` without modifying core pipeline codes. Lost/unrecognized transport responses become `outcome-unknown`; authenticated lookup is the reconciliation path. Core failures/cancellations after entering the procedure call path carry `effectStatus: "unknown"`; the gateway keeps those claims pending and returns `outcome-unknown`, because a late or partially completed effect may still commit.

`PortableApproval` exposes `id`, `capabilityId`, `status`, `reasons`, `types`, and ISO `requestedAt`/`expiresAt`; it excludes stored input and actor records. Approval decisions deliberately have no gateway/model tool. The application provides a separately authenticated approval UI and decision endpoint.

`InvocationReceipt` exposes ID, capability, digest, optional correlation/approval IDs, `state: "pending" | "settled"`, optional outcome, and ISO creation/update times. Pending means no authoritative settled result is available; it does not mean the domain effect has not happened.

## Retries, approvals and reconciliation

1. Persist host run/step/tool-call to invocation-ID mapping before dispatch. Regenerated model tool-call IDs are not durable business identity.
2. The gateway atomically claims actor/namespace/surface plus invocation ID and binds the capability/input fingerprint. Changed input conflicts; a settled identical call returns its recorded result after fresh authorization.
3. A concurrent or interrupted pending call returns unknown and is never stolen after a lease timeout. The handler receives the journal's stable `context.agent.idempotencyKey`.
4. Approval-required is a settled intermediate result. Store its run/call/invocation/approval mapping. The Lambda returns immediately; the agent host suspends or records a waiting state.
5. After an authorized human decision, refresh requester credentials and call `resumeApproval` with the **same original invocation ID**. Current requester identity, current contract revision/exposure, invocation policies, execution policies and procedure middleware are checked. Correlation and the effect key are preserved; approver authority is never substituted.
6. Approval continuation uses compare-and-set admission. A consumed approval is never made reusable after a process crash. Lookup returns the settled result once recorded; interrupted admission remains unknown.

The journal prevents repeat admission for the same key; it does not provide exactly-once effects or close the crash window between a domain commit and receipt storage. Use a transaction with unique business keys, an outbox, or downstream idempotency tokens. Keep receipts for the full replay horizon. For an orphaned pending receipt, an application operator/worker must verify the original execution has stopped, reconcile the domain effect using its stable key, and only then settle a verified outcome through the server-only `InvocationJournal` interface. Never invent success or automatically rerun an uncertain write. Do not expose journal mutation methods to models.

`createInMemoryInvocationJournal()` is explicitly development-only. `InvocationRecord` contains private scope/input/hash/effect-key/claim-token fields in addition to the public receipt. The driver-agnostic Postgres adapter implements atomic `claim`, `claimResume`, `settle`, `get`, and `findApproval`. Failed audit draining may lose the response after a successful receipt write; lookup must precede another effect.

Conversation persistence does not preserve an in-flight agent loop. Host checkpoints, event replay, fresh credentials, replica ownership/fencing, browser tab targeting and deployment recovery remain host/application responsibilities. This library does not implement a workflow engine or claim tested cloud failover.
