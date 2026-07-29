import type { CapabilityEntry, CapabilitySnapshot, Change } from "./types";

const RISK_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/**
 * Classifies every difference between two snapshots.
 *
 * "Widening" means the agent gained reach or a governance control weakened —
 * the set a reviewer must look at even when the diff is large. Note the two
 * cases where the intuitive direction is not the dangerous one:
 *
 * - `sideEffect` counts in BOTH directions. Declaring less than before
 *   (write → read) silently stops every policy keyed on `sideEffect` from
 *   matching, which weakens governance exactly like a new exposure does.
 * - `idempotent: false → true` is widening: it is the flag that lets the
 *   runtime retry a write (SI-11).
 *
 * `unexposed` is not diffed: it is derived from each capability's expose map,
 * so every change in it is already reported as an exposure change.
 */
export function diffSnapshots(before: CapabilitySnapshot, after: CapabilitySnapshot): Change[] {
  const changes: Change[] = [];
  const beforeById = new Map(before.capabilities.map((c) => [c.id, c]));
  const afterById = new Map(after.capabilities.map((c) => [c.id, c]));

  for (const entry of after.capabilities) {
    const previous = beforeById.get(entry.id);
    if (previous) {
      changes.push(...diffEntry(previous, entry));
      continue;
    }
    changes.push(
      entry.expose.length > 0
        ? change(
            "widening",
            entry.id,
            "capability",
            `new capability, exposed on ${entry.expose.join(", ")}` +
              ` (${entry.sideEffect}, risk ${entry.risk}` +
              `${entry.approval?.required ? ", approval required" : ""})`,
          )
        : change("neutral", entry.id, "capability", "new capability, not exposed on any surface"),
    );
  }

  for (const entry of before.capabilities) {
    if (!afterById.has(entry.id)) {
      changes.push(change("narrowing", entry.id, "capability", "capability removed"));
    }
  }

  changes.push(...diffRuntime(before, after));

  const beforeExcluded = new Set(before.excluded);
  const afterExcluded = new Set(after.excluded);
  for (const path of after.excluded) {
    if (!beforeExcluded.has(path)) {
      changes.push(
        change("narrowing", path, "excluded", "procedure is no longer a capability (meta.agent removed)"),
      );
    }
  }
  for (const path of before.excluded) {
    // Suppressed when the same path shows up as a new capability: that line
    // already says it, with the exposure detail attached.
    if (!afterExcluded.has(path) && !afterById.has(path)) {
      changes.push(change("neutral", path, "excluded", "procedure no longer listed as excluded"));
    }
  }

  return changes;
}

/**
 * Runtime-level policies. Absent means "never observed", not "none" — so
 * comparisons only run when both sides know, and the transitions between
 * knowing and not knowing are reported as themselves.
 *
 * Removing a runtime policy is WIDENING. It is the one edit that can strip a
 * conditional approval gate from every capability at once while leaving every
 * per-capability field byte-identical, which is precisely what a snapshot gate
 * exists to catch.
 */
function diffRuntime(before: CapabilitySnapshot, after: CapabilitySnapshot): Change[] {
  const changes: Change[] = [];

  if (!after.runtime) {
    if (before.runtime) {
      changes.push(
        change(
          "widening",
          "(runtime)",
          "runtime",
          "runtime-level policies are no longer observed — this snapshot can no longer " +
            "detect one being removed. Point --entry at the module exporting the runtime.",
        ),
      );
    }
    return changes;
  }

  if (!before.runtime) {
    // Nothing changed in the application; the tool started looking. Neutral so
    // `--fail-on widening` does not go red on an upgrade, but loud, because
    // until the snapshot is rewritten the removal check is inert.
    changes.push(
      change(
        "neutral",
        "(runtime)",
        "runtime",
        `runtime-level policies now observed (${after.runtime.policies.length}: ` +
          `${after.runtime.policies.map((p) => p.name).join(", ") || "none"}). ` +
          "Re-run `orpc-agent snapshot` to record them — until then a removal is invisible.",
      ),
    );
    return changes;
  }

  const beforeByName = new Map(before.runtime.policies.map((p) => [p.name, p]));
  const afterByName = new Map(after.runtime.policies.map((p) => [p.name, p]));

  const removed = before.runtime.policies.filter((p) => !afterByName.has(p.name));
  const added = after.runtime.policies.filter((p) => !beforeByName.has(p.name));

  if (removed.length > 0) {
    changes.push(
      change(
        "widening",
        "(runtime)",
        "runtime.policies",
        `runtime policy removed: ${removed.map((p) => p.name).join(", ")} — it applied to ` +
          "every invocation; any approval, denial or hiding it added is gone",
      ),
    );
  }
  if (added.length > 0) {
    changes.push(
      change(
        "narrowing",
        "(runtime)",
        "runtime.policies",
        `runtime policy added: ${added.map((p) => p.name).join(", ")}`,
      ),
    );
  }

  // A policy that keeps its name but drops a phase stops running there.
  for (const [name, afterPolicy] of afterByName) {
    const beforePolicy = beforeByName.get(name);
    if (!beforePolicy) continue;
    const lost = beforePolicy.phases.filter((p) => !afterPolicy.phases.includes(p));
    const gained = afterPolicy.phases.filter((p) => !beforePolicy.phases.includes(p));
    if (lost.length > 0) {
      changes.push(
        change(
          "widening",
          "(runtime)",
          "runtime.policies",
          `runtime policy ${name} no longer evaluates in: ${lost.join(", ")}`,
        ),
      );
    }
    if (gained.length > 0) {
      changes.push(
        change(
          "narrowing",
          "(runtime)",
          "runtime.policies",
          `runtime policy ${name} now also evaluates in: ${gained.join(", ")}`,
        ),
      );
    }
  }

  if (
    removed.length === 0 &&
    added.length === 0 &&
    before.runtime.policies.some((p, index) => after.runtime?.policies[index]?.name !== p.name)
  ) {
    changes.push(
      change(
        "neutral",
        "(runtime)",
        "runtime.policies",
        `runtime policy order changed: ${before.runtime.policies.map((p) => p.name).join(" → ")}` +
          ` became ${after.runtime.policies.map((p) => p.name).join(" → ")}`,
      ),
    );
  }

  return changes;
}

function diffEntry(before: CapabilityEntry, after: CapabilityEntry): Change[] {
  const changes: Change[] = [];
  const id = after.id;

  const gained = after.expose.filter((s) => !before.expose.includes(s));
  const lost = before.expose.filter((s) => !after.expose.includes(s));
  if (gained.length > 0) {
    changes.push(change("widening", id, "expose", `now exposed on ${gained.join(", ")}`));
  }
  if (lost.length > 0) {
    changes.push(change("narrowing", id, "expose", `no longer exposed on ${lost.join(", ")}`));
  }

  if (before.sideEffect !== after.sideEffect) {
    changes.push(
      change(
        "widening",
        id,
        "sideEffect",
        `sideEffect ${before.sideEffect} → ${after.sideEffect}` +
          " (policies keyed on the old value stop matching)",
      ),
    );
  }

  if (before.risk !== after.risk) {
    const lowered = (RISK_RANK[after.risk] ?? 0) < (RISK_RANK[before.risk] ?? 0);
    changes.push(
      change(lowered ? "widening" : "narrowing", id, "risk", `risk ${before.risk} → ${after.risk}`),
    );
  }

  const wasRequired = before.approval?.required === true;
  const isRequired = after.approval?.required === true;
  if (wasRequired && !isRequired) {
    changes.push(change("widening", id, "approval", "approval no longer required"));
  } else if (!wasRequired && isRequired) {
    changes.push(change("narrowing", id, "approval", "approval now required"));
  }
  if (wasRequired && isRequired && before.approval?.type !== after.approval?.type) {
    changes.push(
      change(
        "neutral",
        id,
        "approval.type",
        `approval type ${before.approval?.type ?? "(none)"} → ${after.approval?.type ?? "(none)"}`,
      ),
    );
  }

  if (before.idempotent !== after.idempotent) {
    changes.push(
      after.idempotent
        ? change(
            "widening",
            id,
            "idempotent",
            "declared idempotent — the runtime may now retry it (SI-11)",
          )
        : change("narrowing", id, "idempotent", "no longer declared idempotent"),
    );
  }

  const beforeRetry = before.retry ? before.retry.maxAttempts : 0;
  const afterRetry = after.retry ? after.retry.maxAttempts : 0;
  if (beforeRetry !== afterRetry) {
    const isWrite = after.sideEffect !== "read" && after.sideEffect !== "none";
    changes.push(
      change(
        afterRetry > beforeRetry && isWrite ? "widening" : "neutral",
        id,
        "retry",
        `retry maxAttempts ${beforeRetry} → ${afterRetry}`,
      ),
    );
  }

  const addedPolicies = after.policies.filter((p) => !before.policies.includes(p));
  const removedPolicies = before.policies.filter((p) => !after.policies.includes(p));
  if (removedPolicies.length > 0) {
    changes.push(
      change("widening", id, "policies", `policy removed: ${removedPolicies.join(", ")}`),
    );
  }
  if (addedPolicies.length > 0) {
    changes.push(change("narrowing", id, "policies", `policy added: ${addedPolicies.join(", ")}`));
  }
  if (
    addedPolicies.length === 0 &&
    removedPolicies.length === 0 &&
    before.policies.some((name, index) => after.policies[index] !== name)
  ) {
    changes.push(
      change(
        "neutral",
        id,
        "policies",
        `policy order changed: ${before.policies.join(" → ")} became ${after.policies.join(" → ")}`,
      ),
    );
  }

  for (const hook of ["output", "approvalInput"] as const) {
    const was = before.redact?.[hook] === true;
    const is = after.redact?.[hook] === true;
    if (was && !is) {
      changes.push(
        change(
          "widening",
          id,
          `redact.${hook}`,
          hook === "output"
            ? "output redaction removed — models now see the raw output"
            : "approval-input redaction removed — approval UIs now see the raw input",
        ),
      );
    } else if (!was && is) {
      changes.push(change("narrowing", id, `redact.${hook}`, `${hook} redaction added`));
    }
  }

  for (const surface of new Set([
    ...Object.keys(before.toolNames ?? {}),
    ...Object.keys(after.toolNames ?? {}),
  ])) {
    const wasName = before.toolNames?.[surface];
    const isName = after.toolNames?.[surface];
    if (wasName !== undefined && isName !== undefined && wasName !== isName) {
      changes.push(
        change(
          "neutral",
          id,
          "toolNames",
          `${surface} tool name ${wasName} → ${isName} (breaks host configs and prompts pinned to the old name)`,
        ),
      );
    }
  }

  if (before.inputSchemaHash !== after.inputSchemaHash) {
    changes.push(
      change("neutral", id, "inputSchema", `input schema changed (${describeHash(before.inputSchemaHash)} → ${describeHash(after.inputSchemaHash)})`),
    );
  }

  if (before.description !== after.description) {
    changes.push(change("neutral", id, "description", "description changed — the model reads this"));
  }

  if (before.timeoutMs !== after.timeoutMs) {
    changes.push(
      change(
        "neutral",
        id,
        "timeoutMs",
        `timeout ${before.timeoutMs ?? "(runtime default)"} → ${after.timeoutMs ?? "(runtime default)"}`,
      ),
    );
  }

  const addedTags = after.tags.filter((t) => !before.tags.includes(t));
  const removedTags = before.tags.filter((t) => !after.tags.includes(t));
  if (addedTags.length > 0 || removedTags.length > 0) {
    const parts = [
      ...(addedTags.length > 0 ? [`+${addedTags.join(" +")}`] : []),
      ...(removedTags.length > 0 ? [`-${removedTags.join(" -")}`] : []),
    ];
    changes.push(change("neutral", id, "tags", `tags ${parts.join(" ")}`));
  }

  return changes;
}

function describeHash(hash: CapabilityEntry["inputSchemaHash"]): string {
  if (hash === null) return "no input";
  if (hash === "unconvertible") return "unconvertible";
  return hash.slice(0, 14);
}

function change(kind: Change["kind"], id: string, field: string, message: string): Change {
  return { kind, id, field, message };
}
