import { CapabilityError } from "../errors";

export type CompositeSignal = {
  signal: AbortSignal;
  /** True when the timeout timer fired (→ TIMEOUT, stage "timeout"). */
  timedOut(): boolean;
  /** True when the caller's signal aborted (→ CANCELLED, stage "cancellation"). */
  cancelledByCaller(): boolean;
  /** Resolves when the composite aborts (never rejects). */
  aborted: Promise<void>;
  dispose(): void;
};

/**
 * Composes the caller's signal with a per-attempt timeout timer into one
 * AbortSignal (SI-12). The abort reason is a CapabilityError so downstream
 * consumers see a meaningful `signal.reason`.
 */
export function createCompositeSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): CompositeSignal {
  const controller = new AbortController();
  let timedOut = false;
  let cancelledByCaller = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveAborted!: () => void;
  const aborted = new Promise<void>((resolve) => {
    resolveAborted = resolve;
  });

  const onCallerAbort = () => {
    cancelledByCaller = true;
    abort(
      new CapabilityError({
        code: "CANCELLED",
        cause: callerSignal?.reason,
      }),
    );
  };

  function abort(reason: CapabilityError) {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    controller.abort(reason);
    resolveAborted();
  }

  if (callerSignal?.aborted) {
    onCallerAbort();
  } else {
    if (callerSignal) callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    timer = setTimeout(() => {
      timedOut = true;
      abort(new CapabilityError({ code: "TIMEOUT" }));
    }, timeoutMs);
    // Never keep the process alive for a governance timer.
    (timer as { unref?: () => void }).unref?.();
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cancelledByCaller: () => cancelledByCaller,
    aborted,
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

/** Waits `ms`, resolving early (true) if the signal aborts. */
export function delay(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(true);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    (timer as { unref?: () => void }).unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
