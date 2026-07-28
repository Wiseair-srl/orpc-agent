/**
 * Never finishes importing — stands in for an entry that blocks at module
 * scope. A pending timer, not an unresolvable promise: Node detects the
 * latter and exits on its own, which would test nothing.
 */
await new Promise((resolve) => setTimeout(resolve, 120_000));

export const capabilities = undefined;
