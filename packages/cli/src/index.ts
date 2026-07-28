// ---- Snapshot model ----
export { buildSnapshot } from "./snapshot";
export { diffSnapshots } from "./diff";
export { canonicalJson, snapshotJson, sha256 } from "./canonical";
export type { CapabilityEntry, CapabilitySnapshot, Change, ChangeKind } from "./types";

// ---- Loading an application's registry ----
export { loadSnapshot, LoadError } from "./load";
export type { LoadOptions } from "./load";

// ---- Rendering ----
export { renderChanges, renderGithub, renderInventory, renderMarkdown } from "./render";
