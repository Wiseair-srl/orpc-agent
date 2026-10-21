import { CapabilityError } from "./errors";
import type { ApprovalRecord } from "./approvals/types";
import type { CapabilityRegistry } from "./registry";
import type { Actor, ExposureSurface, RedactionInfo } from "./types";

/**
 * Builds the second argument of a `meta.redact` hook from an authenticated
 * source: the execution frame at stage 13, or the stored approval record in
 * `redactApprovalInput`. Never from model output or request JSON (SI-2, SI-3).
 *
 * The result is frozen and the actor is a frozen deep copy of its plain data,
 * so a hook cannot write through `info` into the frame or the record. The
 * context is the application's own object and travels by reference — the
 * runtime hands the same object to middleware and handlers.
 */
export function redactionInfo(source: {
  surface: ExposureSurface;
  capabilityId: string;
  actor: Actor;
  context: unknown;
}): RedactionInfo {
  return Object.freeze({
    surface: source.surface,
    capabilityId: source.capabilityId,
    actor: frozenCopy(source.actor) as Actor,
    context: source.context,
  });
}

/** Plain objects and arrays are copied and frozen; anything else passes through. */
function frozenCopy(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(frozenCopy));
  if (value !== null && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const copy: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) copy[key] = frozenCopy(entry);
      return Object.freeze(copy);
    }
  }
  return value;
}

/** The fields of an approval request or record that display redaction reads. */
export type ApprovalDisplaySource = Pick<ApprovalRecord, "capabilityId" | "surface" | "actor" | "input">;

/**
 * What an approval surface may render for a record: `meta.redact.approvalInput`
 * applied to the stored input, with the surface and actor the record was
 * created with (SI-2: never a value the caller supplies). Without a hook the
 * stored input is returned as is.
 *
 * Fails closed: a throwing hook raises `EXECUTION_FAILED` and an unknown
 * capability raises `CAPABILITY_NOT_FOUND` — render nothing, never the raw
 * input, when this throws. The integrity hash still binds the full input
 * (SI-5); display redaction changes what approvers see, not what executes.
 */
export function redactApprovalInput(
  registry: CapabilityRegistry,
  record: ApprovalDisplaySource,
  options: { context: unknown },
): unknown {
  const capability = registry.get(record.capabilityId);
  if (!capability) {
    throw new CapabilityError({
      code: "CAPABILITY_NOT_FOUND",
      stage: "approval",
      cause: new Error(`capability "${record.capabilityId}" is not in the registry`),
    });
  }
  const hook = capability.meta.redact?.approvalInput;
  if (!hook) return record.input;
  try {
    return hook(
      record.input,
      redactionInfo({
        surface: record.surface,
        capabilityId: capability.id,
        actor: record.actor,
        context: options.context,
      }),
    );
  } catch (cause) {
    throw new CapabilityError({ code: "EXECUTION_FAILED", stage: "approval", exposeToModel: false, cause });
  }
}
