/** Renderer observes the main process gate; it never starts or restarts services. */
export interface ServiceGateSnapshot {
  ok: boolean;
  detail?: string[];
  elapsedMs?: number;
}
interface ReadinessAPI {
  services?: {
    readyState: () => Promise<ServiceGateSnapshot | null>;
    waitForReady: () => Promise<unknown>;
  };
  on: (event: string, listener: (payload: unknown) => void) => void;
  off: (event: string, listener: (payload: unknown) => void) => void;
}
export type ServiceGateActivity = "loading" | "waiting" | "failed" | null;
const SLOW_HINT_MS = 15_000;
export function observeServiceReadiness(
  api: ReadinessAPI | undefined,
  onSnapshot: (snapshot: ServiceGateSnapshot) => void,
  onActivity: (activity: ServiceGateActivity) => void,
) {
  let disposed = false;
  let revision = 0;
  let pending = false;
  let waiting = false;
  let reading = false;
  let readId = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let readTimer: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const receive = (value: unknown) => {
    if (
      disposed ||
      !value ||
      typeof value !== "object" ||
      !("ok" in value) ||
      typeof value.ok !== "boolean"
    )
      return;
    ++revision;
    pending = false;
    waiting = false;
    clearTimer();
    onSnapshot(value as ServiceGateSnapshot);
    onActivity(null);
  };
  const fail = (expected: number) => {
    if (disposed || revision !== expected) return;
    pending = false;
    waiting = false;
    clearTimer();
    onActivity("failed");
  };
  const readCached = (initial = false) => {
    if (disposed || reading) return;
    reading = true;
    const expected = revision;
    const id = ++readId;
    // A hung IPC read must not permanently disable the read-only refresh entry.
    readTimer = setTimeout(() => {
      if (disposed || id !== readId) return;
      ++readId;
      reading = false;
      if (revision === expected && pending) {
        waiting = true;
        onActivity("waiting");
      }
    }, SLOW_HINT_MS);
    void Promise.resolve()
      .then(() => {
        if (!api?.services?.readyState)
          throw new Error("Readiness API unavailable");
        return api.services.readyState();
      })
      .then((snapshot) => {
        if (disposed || id !== readId || revision !== expected) return;
        // Main clears its cache while probing. A snapshot is the authoritative result.
        if (snapshot) receive(snapshot);
      })
      .catch(() => {
        if (disposed || id !== readId || revision !== expected) return;
        if (initial) fail(expected);
        else {
          waiting = true;
          onActivity("waiting");
        }
      })
      .finally(() => {
        if (id !== readId) return;
        clearTimeout(readTimer);
        readTimer = undefined;
        reading = false;
      });
  };
  const begin = () => {
    pending = true;
    waiting = false;
    clearTimer();
    onActivity("loading");
    // Waiting is presentation only. Recheck state once without starting another probe.
    timer = setTimeout(() => {
      if (disposed || !pending) return;
      waiting = true;
      onActivity("waiting");
      readCached();
    }, SLOW_HINT_MS);
  };
  // Subscribe first; a late cached response cannot overwrite a newer ready event.
  api?.on("services:ready", receive);
  begin();
  readCached(true);
  return {
    retry() {
      if (disposed) return false;
      if (pending) {
        if (waiting) readCached();
        return false;
      }
      begin();
      const requestedRevision = ++revision;
      void Promise.resolve()
        .then(() => {
          if (!api?.services?.waitForReady)
            throw new Error("Readiness API unavailable");
          return api.services.waitForReady();
        })
        .catch(() => fail(requestedRevision));
      // The IPC acknowledgement is not readiness. Unlock only on result/rejection.
      return true;
    },
    dispose() {
      disposed = true;
      ++readId;
      clearTimer();
      clearTimeout(readTimer);
      api?.off("services:ready", receive);
    },
  };
}
