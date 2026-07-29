import type { CapabilitySnapshot, EntrySource } from "../types";

/**
 * The only bridge between the commands and the Ink views.
 *
 * ink and react are OPTIONAL dependencies, imported dynamically and never
 * from a module `check` reaches. An install that skipped them — or a run with
 * no TTY, or piped output — falls back to the plain renderers in render.ts,
 * which stay the tested path and the contract (ADR-015 §7).
 */

export function interactive(stream: { isTTY?: boolean }): boolean {
  return Boolean(stream.isTTY) && !process.env.CI && process.env.NO_COLOR === undefined;
}

async function ink(): Promise<typeof import("ink") | undefined> {
  try {
    return await import("ink");
  } catch {
    return undefined;
  }
}

/** Returns false when Ink is unavailable, so the caller can print plain text. */
export async function renderInventoryInk(
  snapshot: CapabilitySnapshot,
  entrySource: EntrySource,
): Promise<boolean> {
  const runtime = await ink();
  if (!runtime) return false;
  const [{ createElement }, { Inventory }] = await Promise.all([
    import("react"),
    import("./Inventory.js"),
  ]);
  const instance = runtime.render(createElement(Inventory, { snapshot, entrySource }));
  await instance.waitUntilExit();
  return true;
}

export type InitResult = { ok: true; code: number } | { ok: false };

export async function runInitUi(options: {
  cwd: string;
  candidates: string[];
  snapshotPath: string;
}): Promise<InitResult> {
  const runtime = await ink();
  if (!runtime) return { ok: false };
  const [{ createElement }, { Init }] = await Promise.all([
    import("react"),
    import("./Init.js"),
  ]);

  let code = 0;
  const instance = runtime.render(
    createElement(Init, { ...options, onExit: (value: number) => (code = value) }),
  );
  await instance.waitUntilExit();
  return { ok: true, code };
}
