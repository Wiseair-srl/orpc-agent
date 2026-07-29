import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CapabilitySnapshot, EntrySource } from "./types";

export type LoadOptions = {
  entry: string;
  exportName?: string;
  descriptions?: boolean;
  timeoutMs?: number;
  cwd?: string;
  /** Explicit module to preload in the child (`node --import <spec>`). */
  importSpecifier?: string;
};

export class LoadError extends Error {
  readonly detail: string | undefined;
  constructor(message: string, detail?: string) {
    super(message);
    this.name = "LoadError";
    this.detail = detail;
  }
}

const CHILD_ENTRY = "child.js";
const EXIT_MODULE_LOAD_FAILED = 10;

/**
 * Imports the application's entry module in a child process and returns the
 * capability snapshot it yields.
 *
 * The child gets `ORPC_AGENT_INSPECT=1` so an application can guard its own
 * import-time side effects; nothing here can prevent them, which is why the
 * import is isolated and time-boxed rather than trusted.
 */
export async function loadSnapshot(
  options: LoadOptions,
): Promise<{
  snapshot: CapabilitySnapshot;
  usedImport: string | undefined;
  entrySource: EntrySource;
  /** Export name of a runtime over the same registry that was not read. */
  runtimeAvailableAs?: string;
}> {
  const cwd = options.cwd ?? process.cwd();
  const entry = isAbsolute(options.entry) ? options.entry : resolve(cwd, options.entry);
  const timeoutMs = options.timeoutMs ?? 30_000;

  const isTypeScript = /\.[cm]?tsx?$/.test(entry);
  const nativeTypeScript = typeof process.features.typescript === "string";
  const explicit = options.importSpecifier;
  const detected = isTypeScript && !nativeTypeScript ? findLoader(cwd) : undefined;

  if (isTypeScript && !nativeTypeScript && !explicit && !detected) {
    throw new LoadError(
      `cannot load the TypeScript entry ${options.entry}`,
      `this Node (${process.version}) does not strip TypeScript and neither tsx nor jiti is ` +
        "installed in the project. Use Node >= 22.18, install tsx, pass --import <module>, " +
        "or point --entry at compiled JavaScript.",
    );
  }

  const first = await runChild(entry, cwd, timeoutMs, explicit ?? detected, options);
  if (first.ok) {
    return {
      snapshot: first.snapshot,
      usedImport: explicit ?? detected,
      entrySource: first.entrySource,
      ...(first.runtimeAvailableAs ? { runtimeAvailableAs: first.runtimeAvailableAs } : {}),
    };
  }

  // Native stripping handles type annotations but not TypeScript that needs
  // real transformation (enums, namespaces, decorators). One retry through an
  // available loader turns that class of failure into a working run.
  const fallback = explicit ? undefined : findLoader(cwd);
  if (first.code === EXIT_MODULE_LOAD_FAILED && fallback && fallback !== detected) {
    const second = await runChild(entry, cwd, timeoutMs, fallback, options);
    if (second.ok) {
      return {
        snapshot: second.snapshot,
        usedImport: fallback,
        entrySource: second.entrySource,
        ...(second.runtimeAvailableAs ? { runtimeAvailableAs: second.runtimeAvailableAs } : {}),
      };
    }
    // A retry that died before reporting anything (a broken loader, say) has
    // nothing to say about the user's code. Keep the original diagnosis.
    if (second.reported) throw new LoadError(second.message, second.detail);
  }

  throw new LoadError(first.message, first.detail);
}

type ChildOutcome =
  | {
      ok: true;
      snapshot: CapabilitySnapshot;
      entrySource: EntrySource;
      runtimeAvailableAs?: string;
    }
  | {
      ok: false;
      code: number;
      message: string;
      detail: string | undefined;
      /** True when the child itself diagnosed the failure, rather than dying first. */
      reported: boolean;
    };

function runChild(
  entry: string,
  cwd: string,
  timeoutMs: number,
  importSpecifier: string | undefined,
  options: LoadOptions,
): Promise<ChildOutcome> {
  const outFile = join(tmpdir(), `orpc-agent-inspect-${randomUUID()}.json`);
  const childPath = join(fileURLToPath(new URL(".", import.meta.url)), CHILD_ENTRY);
  const args = [
    ...(importSpecifier ? ["--import", importSpecifier] : []),
    childPath,
    entry,
    outFile,
    JSON.stringify({
      exportName: options.exportName,
      descriptions: options.descriptions !== false,
    }),
  ];

  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, ORPC_AGENT_INSPECT: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle({
        ok: false,
        code: -1,
        reported: true,
        message: `loading ${entry} timed out after ${timeoutMs}ms`,
        detail:
          "the entry module did not finish importing. It likely does work at import time " +
          "(connecting, migrating, starting a server). Guard it with ORPC_AGENT_INSPECT, " +
          "move it behind a function, or raise --timeout.",
      });
    }, timeoutMs);

    let settled = false;
    const settle = (outcome: ChildOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rmSync(outFile, { force: true });
      resolvePromise(outcome);
    };

    child.on("error", (error) => {
      settle({
        ok: false,
        code: -1,
        reported: false,
        message: "could not spawn Node",
        detail: error.message,
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      let payload: {
        ok: boolean;
        snapshot?: CapabilitySnapshot;
        entrySource?: EntrySource;
        runtimeAvailableAs?: string;
        message?: string;
        detail?: string;
      };
      try {
        payload = JSON.parse(readFileSync(outFile, "utf8"));
      } catch {
        settle({
          ok: false,
          code: code ?? -1,
          reported: false,
          message: `the loader process exited with code ${code} without producing a result`,
          detail: [stderr.trim(), stdout.trim()].filter(Boolean).join("\n") || undefined,
        });
        return;
      }
      if (payload.ok && payload.snapshot) {
        settle({
          ok: true,
          snapshot: payload.snapshot,
          entrySource: payload.entrySource ?? "registry",
          ...(payload.runtimeAvailableAs
            ? { runtimeAvailableAs: payload.runtimeAvailableAs }
            : {}),
        });
        return;
      }
      settle({
        ok: false,
        code: code ?? -1,
        reported: true,
        message: payload.message ?? "the loader process failed",
        detail: payload.detail,
      });
    });
  });
}

/**
 * tsx and jiti are used if the project already has one; neither is a
 * dependency. The hook is resolved to an absolute file URL rather than passed
 * as a bare specifier: CommonJS and ESM resolution do not always agree on
 * where a package lives (they disagree under pnpm), and a `--import` that the
 * child cannot resolve would replace the real diagnosis with a loader error.
 */
function findLoader(cwd: string): string | undefined {
  const require = createRequire(join(cwd, "package.json"));
  for (const hook of ["tsx", "jiti/register"]) {
    try {
      return pathToFileURL(require.resolve(hook)).href;
    } catch {
      // not installed here; try the next one
    }
  }
  return undefined;
}
