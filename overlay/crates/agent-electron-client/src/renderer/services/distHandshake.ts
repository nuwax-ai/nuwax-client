import type { DistHandshakeView } from "@shared/types/distVersionHandshake";

export interface DistHandshakeState {
  snapshot: DistHandshakeView | null;
  checking: boolean;
}

interface PrivateHandshakeApi {
  app?: { getDistHandshake?: (force?: boolean) => Promise<DistHandshakeView> };
  on?: (event: string, listener: () => void) => void;
  off?: (event: string, listener: () => void) => void;
}

const SOURCE_EVENTS = ["nuwax:serverHostChanged", "nuwax:loopback-changed", "nuwax:authChanged"];
export const DIST_HANDSHAKE_READ_TIMEOUT_MS = 7_000;

/** Ignore old IPC replies after context changes, retries and unmount. */
export function observeDistHandshake(api: PrivateHandshakeApi | undefined, update: (state: DistHandshakeState) => void) {
  let disposed = false, revision = 0;
  let pending: Promise<void> | null = null;
  const deadlines = new Map<ReturnType<typeof setTimeout>, () => void>();
  const getSnapshot = api?.app?.getDistHandshake;

  const refresh = (force = false): Promise<void> => {
    if (disposed || typeof getSnapshot !== "function") return Promise.resolve();
    if (pending) return pending;
    const current = ++revision;
    update({ snapshot: null, checking: true });
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), DIST_HANDSHAKE_READ_TIMEOUT_MS);
      deadlines.set(timer, () => resolve(null));
    });
    const requested = Promise.resolve().then(() => getSnapshot(force)).catch(() => null);
    const operation = Promise.race([requested, deadline]).then(snapshot => {
      if (!disposed && revision === current) update({ snapshot, checking: false });
    }).finally(() => {
      clearTimeout(timer!);
      deadlines.delete(timer!);
      if (pending === operation) pending = null;
    });
    pending = operation;
    return operation;
  };
  const changed = () => {
    if (disposed) return;
    ++revision;
    pending = null;
    update({ snapshot: null, checking: false });
    void refresh();
  };
  if (typeof getSnapshot === "function") for (const event of SOURCE_EVENTS) api?.on?.(event, changed);
  return {
    refresh,
    dispose() {
      disposed = true;
      ++revision;
      for (const [timer, settle] of deadlines) {
        clearTimeout(timer);
        settle();
      }
      deadlines.clear();
      if (typeof getSnapshot === "function") for (const event of SOURCE_EVENTS) api?.off?.(event, changed);
    },
  };
}

/** A cloud diagnostic must not warn on direct mode, proxy mode or another document. */
export function shouldShowDistSnapshotNotice(snapshot: DistHandshakeView | null, guestUrl: string): boolean {
  if (!snapshot || !["different", "behind"].includes(snapshot.relation) || snapshot.gateway?.mode !== "dist"
    || !snapshot.bundled || !snapshot.cloud || snapshot.checkedAt === null) return false;
  try {
    const guest = new URL(guestUrl), gateway = new URL(snapshot.gateway.origin);
    return ["http:", "https:"].includes(guest.protocol) && !guest.username && !guest.password
      && guest.origin === gateway.origin;
  } catch { return false; }
}
