/**
 * 单元测试：distVersionHandshake —— 云端 dist 版本握手（NW-272）。
 *
 * 覆盖：载荷解析容错、semver 比较口径（拉不到不判定）、快照集成
 * （本地 bundled 读真实临时 dist、云端 fetch 注入桩、TTL 重用与
 * 域名切换缓存失效）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const mocks = vi.hoisted(() => ({
  isPackaged: { value: false },
  appPath: { value: "/app/crates/agent-electron-client" },
}));

vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return mocks.isPackaged.value;
    },
    getAppPath: () => mocks.appPath.value,
    getPath: () => "/tmp",
  },
}));

vi.mock("electron-log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  createDistHandshake,
  type DistVersionFetch,
} from "./distVersionHandshake";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dist-handshake-"));

function writeBundledDist(payload: unknown) {
  const distDir = path.join(tempRoot, "bundled-dist");
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(
    path.join(distDir, "version.json"),
    JSON.stringify(payload),
    "utf8",
  );
  process.env.NUWAX_FRONTEND_DIST = distDir;
}

interface FetchCall {
  url: string;
}

/** 可编程 fetch 桩：记录调用并按次返回预设响应/抛错。 */
function fetchStub(
  plan: Array<
    { ok: true; body: unknown } | { ok: false; status: number } | { throw: Error }
  >,
) {
  const calls: FetchCall[] = [];
  const impl: DistVersionFetch = async (url) => {
    calls.push({ url });
    const step = plan[Math.min(calls.length - 1, plan.length - 1)];
    if ("throw" in step) throw step.throw;
    if (!step.ok) return { ok: false, json: async () => null };
    return { ok: true, json: async () => step.body };
  };
  return { impl, calls };
}

const CLOCK = { t: 1_000_000 };
const tick = (ms: number) => {
  CLOCK.t += ms;
};

beforeEach(() => {
  CLOCK.t = 1_000_000;
  writeBundledDist({ name: "nuwax-frontend", version: "3.0.23", gitHash: "aaa1111" });
});

afterEach(() => {
  vi.resetModules();
  delete process.env.NUWAX_FRONTEND_DIST;
});

describe("parseDistVersionPayload", () => {
  it("合法载荷读取 version/gitHash；name 缺省补齐", async () => {
    const { parseDistVersionPayload } = await import("./distVersionHandshake");
    expect(
      parseDistVersionPayload({ version: "1.2.0", gitHash: "abc1234" }),
    ).toEqual({ name: "nuwax-frontend", version: "1.2.0", gitHash: "abc1234" });
    expect(parseDistVersionPayload({ name: "x", version: "1.0.0" })).toEqual({
      name: "x",
      version: "1.0.0",
      gitHash: undefined,
    });
  });

  it("非对象/缺 version/空 version → null（不抛）", async () => {
    const { parseDistVersionPayload } = await import("./distVersionHandshake");
    expect(parseDistVersionPayload(null)).toBeNull();
    expect(parseDistVersionPayload("1.2.0")).toBeNull();
    expect(parseDistVersionPayload({ name: "nuwax-frontend" })).toBeNull();
    expect(parseDistVersionPayload({ version: "" })).toBeNull();
  });
});

describe("compareDistVersions", () => {
  it("任一为 null → unknown（拉不到不判定）", async () => {
    const { compareDistVersions } = await import("./distVersionHandshake");
    const v = { name: "n", version: "1.0.0" };
    expect(compareDistVersions(null, v)).toBe("unknown");
    expect(compareDistVersions(v, null)).toBe("unknown");
  });

  it("非 x.y.z 语义化版本（预发布/短版本/自定义串）→ unknown", async () => {
    const { compareDistVersions } = await import("./distVersionHandshake");
    expect(
      compareDistVersions(
        { name: "n", version: "1.2.3-beta.1" },
        { name: "n", version: "1.2.3" },
      ),
    ).toBe("unknown");
    expect(
      compareDistVersions(
        { name: "n", version: "1.2" },
        { name: "n", version: "1.2.0" },
      ),
    ).toBe("unknown");
    expect(
      compareDistVersions(
        { name: "n", version: "dev" },
        { name: "n", version: "1.2.0" },
      ),
    ).toBe("unknown");
  });

  it("按段数值比较；相等版本必须有提交身份才能证明一致", async () => {
    const { compareDistVersions } = await import("./distVersionHandshake");
    expect(
      compareDistVersions(
        { name: "n", version: "1.2.3" },
        { name: "n", version: "1.10.0" },
      ),
    ).toBe("behind");
    expect(
      compareDistVersions(
        { name: "n", version: "2.0.0" },
        { name: "n", version: "1.9.9" },
      ),
    ).toBe("ahead");
    expect(
      compareDistVersions(
        { name: "n", version: "3.0.23" },
        { name: "n", version: "3.0.23" },
      ),
    ).toBe("unknown");
  });
});

describe("createDistHandshake 快照集成", () => {
  it("云端同版本 → match；URL 为 backendOrigin + /version.json", async () => {
    const { impl, calls } = fetchStub([
      { ok: true, body: { version: "3.0.23", gitHash: "aaa1111" } },
    ]);
    const hs = createDistHandshake({ fetchImpl: impl, now: () => CLOCK.t });
    const snap = await hs.getSnapshot("https://cloud.example.com");
    expect(snap.relation).toBe("match");
    expect(snap.cloud?.version).toBe("3.0.23");
    expect(snap.checkedAt).toBe(CLOCK.t);
    expect(calls[0]?.url).toBe("https://cloud.example.com/version.json");
  });

  it("云端更新 → behind（快照落后场景）", async () => {
    const { impl } = fetchStub([
      { ok: true, body: { version: "3.0.24", gitHash: "bbb2222" } },
    ]);
    const hs = createDistHandshake({ fetchImpl: impl, now: () => CLOCK.t });
    const snap = await hs.getSnapshot("https://cloud.example.com");
    expect(snap.relation).toBe("behind");
  });

  it("网络失败/非 200/载荷损坏 → unknown 且 checkedAt=null（拉不到不判定）", async () => {
    const fail = fetchStub([{ throw: new Error("network down") }]);
    const hs1 = createDistHandshake({ fetchImpl: fail.impl, now: () => CLOCK.t });
    const s1 = await hs1.getSnapshot("https://cloud.example.com");
    expect(s1.relation).toBe("unknown");
    expect(s1.cloud).toBeNull();
    expect(s1.checkedAt).toBeNull();

    const http404 = fetchStub([{ ok: false, status: 404 }]);
    const hs2 = createDistHandshake({ fetchImpl: http404.impl, now: () => CLOCK.t });
    expect((await hs2.getSnapshot("https://x.example.com")).relation).toBe("unknown");

    const badBody = fetchStub([{ ok: true, body: { nope: 1 } }]);
    const hs3 = createDistHandshake({ fetchImpl: badBody.impl, now: () => CLOCK.t });
    expect((await hs3.getSnapshot("https://x.example.com")).relation).toBe("unknown");
  });

  it("backendOrigin 为空 → 直接 unknown，不发请求", async () => {
    const { impl, calls } = fetchStub([{ ok: true, body: { version: "9.9.9" } }]);
    const hs = createDistHandshake({ fetchImpl: impl, now: () => CLOCK.t });
    const snap = await hs.getSnapshot("");
    expect(snap.relation).toBe("unknown");
    expect(calls).toHaveLength(0);
  });

  it("TTL 内 force=true 直接重拉（重新检查按钮路径）", async () => {
    const { impl, calls } = fetchStub([
      { ok: true, body: { version: "3.0.23", gitHash: "aaa1111" } },
      { ok: true, body: { version: "3.0.24" } },
    ]);
    const hs = createDistHandshake({ fetchImpl: impl, now: () => CLOCK.t });
    expect((await hs.getSnapshot("https://cloud.example.com")).relation).toBe(
      "match",
    );
    expect(
      (
        await hs.getSnapshot("https://cloud.example.com", { force: true })
      ).relation,
    ).toBe("behind");
    expect(calls).toHaveLength(2);
  });

  it("TTL 内复用成功结果不重拉；窗口外失败不再保留成功结论", async () => {
    let mode: "good" | "bad" = "good";
    const { impl, calls } = fetchStub([{ ok: true, body: { version: "3.0.23", gitHash: "aaa1111" } }]);
    const attempts: string[] = []; // 含失败尝试的每次实际 fetch（内层 calls 只记成功路径）
    const dynamicImpl: DistVersionFetch = async (url, init) => {
      attempts.push(url);
      if (mode === "bad") throw new Error("flux");
      return impl(url, init);
    };
    const hs = createDistHandshake({
      fetchImpl: dynamicImpl,
      now: () => CLOCK.t,
      ttlMs: 300_000,
    });

    await hs.getSnapshot("https://cloud.example.com");
    tick(60_000);
    await hs.getSnapshot("https://cloud.example.com");
    expect(calls).toHaveLength(1); // TTL 内复用

    mode = "bad";
    tick(60_000); // 仍在 TTL 内（120s < 300s）：连失败都不触发 fetch
    const snapInTtl = await hs.getSnapshot("https://cloud.example.com");
    expect(snapInTtl.relation).toBe("match");
    expect(calls).toHaveLength(1);

    tick(300_000);
    const snapAfter = await hs.getSnapshot("https://cloud.example.com");
    expect(attempts).toHaveLength(2);
    expect(snapAfter.relation).toBe("unknown");
    expect(snapAfter.checkedAt).toBeNull();
  });

  it("域名切换（backendOrigin 变化）→ 缓存失效重新拉取", async () => {
    const { impl, calls } = fetchStub([
      { ok: true, body: { version: "3.0.23", gitHash: "aaa1111" } },
      { ok: true, body: { version: "3.0.24" } },
    ]);
    const hs = createDistHandshake({ fetchImpl: impl, now: () => CLOCK.t });
    expect((await hs.getSnapshot("https://a.example.com")).relation).toBe("match");
    expect((await hs.getSnapshot("https://b.example.com")).relation).toBe("behind");
    expect(calls.map((c) => c.url)).toEqual([
      "https://a.example.com/version.json",
      "https://b.example.com/version.json",
    ]);
  });

  it("并发调用共享同一 inflight 请求", async () => {
    const { impl, calls } = fetchStub([
      { ok: true, body: { version: "3.0.23", gitHash: "aaa1111" } },
      { ok: true, body: { version: "3.0.23", gitHash: "aaa1111" } },
    ]);
    const hs = createDistHandshake({ fetchImpl: impl, now: () => CLOCK.t });
    const [s1, s2] = await Promise.all([
      hs.getSnapshot("https://cloud.example.com"),
      hs.getSnapshot("https://cloud.example.com"),
    ]);
    expect(calls).toHaveLength(1);
    expect(s1.relation).toBe("match");
    expect(s2.relation).toBe("match");
  });
});

describe("snapshot identity and navigation races", () => {
  it("same release label with different commits is different, never match or behind", async () => {
    const { compareDistVersions } = await import("./distVersionHandshake");
    expect(compareDistVersions(
      { name: "nuwax-frontend", version: "3.0.3", gitHash: "aaaa1111" },
      { name: "nuwax-frontend", version: "3.0.3", gitHash: "bbbb2222" },
    )).toBe("different");
    expect(compareDistVersions(
      { name: "nuwax-frontend", version: "3.0.3" },
      { name: "nuwax-frontend", version: "3.0.3" },
    )).toBe("unknown");
  });

  it("short and full commit IDs for the same build are compatible", async () => {
    const { compareDistVersions } = await import("./distVersionHandshake");
    expect(compareDistVersions(
      { name: "nuwax-frontend", version: "3.0.3", gitHash: "aaaa111" },
      { name: "nuwax-frontend", version: "3.0.3", gitHash: "aaaa111122223333444455556666777788889999" },
    )).toBe("match");
  });

  it("does not request credentials, path/query payloads or non-HTTP backend URLs", async () => {
    const { impl, calls } = fetchStub([{ ok: true, body: { version: "9.0.0" } }]);
    const hs = createDistHandshake({ fetchImpl: impl, now: () => CLOCK.t });
    for (const origin of ["file:///tmp", "https://user:secret@example.com", "https://example.com/private", "https://example.com?ticket=secret", "not-a-url"]) {
      expect((await hs.getSnapshot(origin)).relation).toBe("unknown");
    }
    expect(calls).toEqual([]);
  });

  it("an expired success never authorizes a warning after the current fetch fails", async () => {
    const { impl } = fetchStub([
      { ok: true, body: { version: "3.0.24" } },
      { throw: new Error("offline https://example.com/?ticket=secret") },
    ]);
    const hs = createDistHandshake({ fetchImpl: impl, now: () => CLOCK.t, ttlMs: 100 });
    expect((await hs.getSnapshot("https://example.com")).relation).toBe("behind");
    tick(101);
    expect(await hs.getSnapshot("https://example.com")).toMatchObject({
      relation: "unknown", cloud: null, checkedAt: null,
    });
  });

  it("a late old-domain response cannot clear or replace the current in-flight request", async () => {
    const pending = new Map<string, (value: any) => void>();
    const calls: string[] = [];
    const impl: DistVersionFetch = (url) => {
      calls.push(url);
      return new Promise(resolve => pending.set(url, resolve));
    };
    const hs = createDistHandshake({ fetchImpl: impl, now: () => CLOCK.t });
    const old = hs.getSnapshot("https://old.example.com");
    const current = hs.getSnapshot("https://current.example.com");
    await Promise.resolve();
    pending.get("https://old.example.com/version.json")!({ ok: true, json: async () => ({ version: "9.0.0" }) });
    expect((await old).relation).toBe("unknown");
    const alsoCurrent = hs.getSnapshot("https://current.example.com");
    expect(calls).toHaveLength(2);
    pending.get("https://current.example.com/version.json")!({ ok: true, json: async () => ({ version: "3.0.24" }) });
    expect((await current).relation).toBe("behind");
    expect((await alsoCurrent).relation).toBe("behind");
    expect((await hs.getSnapshot("https://current.example.com")).cloud?.version).toBe("3.0.24");
  });

  it("changing the account generation invalidates same-origin cached results", async () => {
    const { impl, calls } = fetchStub([
      { ok: true, body: { version: "3.0.23", gitHash: "aaa1111" } },
      { ok: true, body: { version: "3.0.24", gitHash: "bbb2222" } },
    ]);
    const hs = createDistHandshake({ fetchImpl: impl, now: () => CLOCK.t });
    await hs.getSnapshot("https://example.com", { scope: 1 });
    expect((await hs.getSnapshot("https://example.com", { scope: 2 })).relation).toBe("behind");
    expect(calls).toHaveLength(2);
  });

  it("bounds waiting even when a fetch adapter ignores abort", async () => {
    vi.useFakeTimers();
    try {
      const hs = createDistHandshake({ fetchImpl: () => new Promise(() => {}), timeoutMs: 50 });
      const result = hs.getSnapshot("https://example.com");
      await vi.advanceTimersByTimeAsync(51);
      expect((await result).relation).toBe("unknown");
    } finally { vi.useRealTimers(); }
  });
});
