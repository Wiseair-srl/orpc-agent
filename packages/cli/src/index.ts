// ---- Snapshot model ----
export { buildSnapshot, governanceOf } from "./snapshot";
export type { SnapshotSource } from "./snapshot";
export { diffSnapshots } from "./diff";
export { canonicalJson, snapshotJson, sha256 } from "./canonical";
export { SNAPSHOT_VERSION } from "./types";
export type {
  CapabilityEntry,
  CapabilitySnapshot,
  Change,
  ChangeKind,
  EntrySource,
  RuntimeSnapshot,
} from "./types";

// ---- Loading an application's registry ----
export { loadSnapshot, LoadError } from "./load";
export type { LoadOptions } from "./load";

// ---- Rendering ----
export { renderChanges, renderGithub, renderInventory, renderMarkdown } from "./render";
