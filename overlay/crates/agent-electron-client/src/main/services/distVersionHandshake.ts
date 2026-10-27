import log from "electron-log";
import type {
  DistBuildVersion,
  DistHandshakeSnapshot,
  DistVersionRelation,
} from "@shared/types/distVersionHandshake";
import { getBundledDistVersion } from "./frontendDistVersion";
export type { DistHandshakeSnapshot, DistVersionRelation } from "@shared/types/distVersionHandshake";

export type DistVersionFetch = (
  url: string,
  init?: { signal?: AbortSignal; redirect?: "error"; credentials?: "omit"; cache?: "no-store" },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export interface DistHandshakeOptions {
  fetchImpl?: DistVersionFetch;
  now?: () => number;
  timeoutMs?: number;
  ttlMs?: number;
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMMIT = /^[a-f\d]{7,64}$/i;

export function parseDistVersionPayload(raw: unknown): DistBuildVersion | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.version !== "string" || !rec.version.trim() || rec.version.length > 100) return null;
  return {
    name: typeof rec.name === "string" && rec.name.length <= 100 ? rec.name : "nuwax-frontend",
    version: rec.version,
    gitHash: typeof rec.gitHash === "string" && COMMIT.test(rec.gitHash) ? rec.gitHash.toLowerCase() : undefined,
  };
}

/** Equal release labels do not prove equal snapshots; commit hashes have no time order. */
export function compareDistVersions(local: DistBuildVersion | null, cloud: DistBuildVersion | null): DistVersionRelation {
  if (!local || !cloud || !SEMVER.test(local.version) || !SEMVER.test(cloud.version)) return "unknown";
  const a = local.version.split(".").map(Number);
  const b = cloud.version.split(".").map(Number);
  if (![...a, ...b].every(Number.isSafeInteger)) return "unknown";
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? "behind" : "ahead";
  const left = local.gitHash?.toLowerCase(), right = cloud.gitHash?.toLowerCase();
  if (!left || !right || !COMMIT.test(left) || !COMMIT.test(right)) return "unknown";
  return left.startsWith(right) || right.startsWith(left) ? "match" : "different";
}

function backendOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    return url.origin;
  } catch { return null; }
}

export interface DistHandshake {
  getSnapshot(origin: string, options?: { force?: boolean; scope?: number }): Promise<DistHandshakeSnapshot>;
}

/** The configured backend is read directly; the loopback's version.json is the bundled copy. */
export function createDistHandshake(options: DistHandshakeOptions = {}): DistHandshake {
  const doFetch = options.fetchImpl ?? (fetch as DistVersionFetch);
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const ttlMs = options.ttlMs ?? 300_000;
  let context = "", generation = 0;
  let success: { at: number; cloud: DistBuildVersion } | null = null;
  let inflight: { generation: number; promise: Promise<DistBuildVersion | null> } | null = null;

  async function fetchCloud(origin: string): Promise<DistBuildVersion | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<null>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs);
    });
    // Catch the whole fetch+body promise even when the timeout wins. Adapters
    // ignoring abort cannot hold the UI forever or leak a late rejection.
    const request = Promise.resolve().then(async () => {
      const response = await doFetch(`${origin}/version.json`, {
        signal: controller.signal, redirect: "error", credentials: "omit", cache: "no-store",
      });
      return response.ok ? parseDistVersionPayload(await response.json()) : null;
    }).catch(() => {
      log.info("[DistVersionHandshake] cloud check unavailable");
      return null;
    });
    try { return await Promise.race([request, timeout]); }
    finally { clearTimeout(timer!); }
  }

  return {
    async getSnapshot(origin, opts = {}) {
      const base = backendOrigin(origin);
      const bundled = getBundledDistVersion();
      const empty = (): DistHandshakeSnapshot => ({ backendOrigin: base ?? "", bundled, cloud: null, relation: "unknown", checkedAt: null });
      const nextContext = base ? `${base}\n${opts.scope ?? 0}` : "";
      if (context !== nextContext) {
        context = nextContext;
        ++generation;
        success = null;
        inflight = null;
      }
      if (!base) return empty();
      if (!opts.force && success && now() >= success.at && now() - success.at < ttlMs) {
        return { backendOrigin: base, bundled, cloud: success.cloud, relation: compareDistVersions(bundled, success.cloud), checkedAt: success.at };
      }
      const captured = generation;
      const pending = inflight ?? { generation: captured, promise: fetchCloud(base) };
      inflight = pending;
      const cloud = await pending.promise;
      if (captured !== generation || context !== nextContext) return empty();
      if (inflight === pending) inflight = null;
      if (!cloud) {
        success = null;
        return empty();
      }
      success = { cloud, at: now() };
      return { backendOrigin: base, bundled, cloud, relation: compareDistVersions(bundled, cloud), checkedAt: success.at };
    },
  };
}

export const distHandshake = createDistHandshake();
