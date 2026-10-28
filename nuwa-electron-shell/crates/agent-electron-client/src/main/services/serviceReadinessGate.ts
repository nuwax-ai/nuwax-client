import type { ServicesGateResult } from "./servicesGate";

/** A null cache means a probe is active; retries share that probe, including older pages. */
export function createServiceReadinessGate(options: {
  probe: () => Promise<ServicesGateResult>;
  publish: (result: ServicesGateResult) => void;
  warn: (reason: "probe-failed" | "delivery-failed") => void;
}) {
  let result: ServicesGateResult | null = null;
  let pending: Promise<ServicesGateResult> | undefined;
  return {
    result: () => result,
    run(): Promise<ServicesGateResult> {
      if (pending) return pending;
      result = null;
      const started = Date.now();
      pending = Promise.resolve().then(options.probe).catch(() => {
        options.warn("probe-failed");
        return { ok: false, detail: ["gate-unavailable"], elapsedMs: Date.now() - started };
      }).then(next => {
        // Renderer may miss the push while reloading; the completed cache stays readable.
        result = next;
        try { options.publish(next); }
        catch { options.warn("delivery-failed"); }
        return next;
      }).finally(() => { pending = undefined; });
      return pending;
    },
  };
}
