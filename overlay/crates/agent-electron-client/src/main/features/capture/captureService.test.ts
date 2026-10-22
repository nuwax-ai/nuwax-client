/**
 * 单元测试: captureService - 单会话状态机、校验、取消、结果与能力
 *
 * 全部依赖用假实现注入。覆盖：
 * - 参数非法 → invalid-argument（且引擎不被调用）；webp 当前编码器不支持 → unsupported
 * - 平台不支持（freebsd）→ unsupported 且 capabilities.available=false；权限 denied → permission-denied
 * - 成功路径：状态 selecting→encoding→idle；resultId 可 readChunk 取回同一份字节；release 后取不到
 * - 用户取消（引擎返回 null）→ canceled；调用方 cancel() 中止 → canceled；结果不入库
 * - busy：会话进行中第二次调用被拒绝；结束后可再次发起
 * - 引擎抛错 → failed 且状态回到 idle
 * - maxBytes 下探后 qualityUsed 降低并标记 exceedsMaxBytes
 * - endSession：中止进行中的会话并清空全部结果
 * - record：无录制引擎 → unsupported；输出格式引擎不支持 → encoder-unavailable；校验先于其他
 */

import { describe, it, expect, vi } from "vitest";
import { createCaptureService, type CaptureServiceDeps, type StillEngine } from "./captureService";
import { createResultStore, type ResultFs } from "./results";
import { createNativeImageEncoder, type NativeImageLike } from "./stillEncoder";
import type { ScratchDir } from "../_kit/scratchDir";
import type { CaptureState } from "@shared/features/capture/contract";

const image = (width = 800, height = 600): NativeImageLike => ({
  getSize: () => ({ width, height }),
  toPNG: () => Buffer.from("PNGDATA-0123456789"),
  toJPEG: (q) => Buffer.alloc(q * 10, 1),
});

function memoryResults() {
  const files = new Map<string, Buffer>();
  const fs: ResultFs = {
    writeFileSync: (p, d) => void files.set(p, d),
    openSync: (p) => [...files.keys()].indexOf(p) + 10,
    readSync: (fd, buf, off, len, pos) => {
      const slice = [...files.values()][fd - 10].subarray(pos, pos + len);
      slice.copy(buf, off);
      return slice.length;
    },
    closeSync: () => undefined,
  };
  const scratch: ScratchDir = {
    root: "/s",
    isValidId: () => true,
    create: (id) => `/s/${id}`,
    resolve: () => null,
    remove: vi.fn(),
    sweep: () => 0,
  };
  let n = 0;
  return createResultStore(scratch, fs, () => `res${String(++n).padStart(8, "0")}`);
}

function setup(overrides: Partial<CaptureServiceDeps> = {}, engine?: StillEngine) {
  const stillEngine: StillEngine = engine ?? {
    captureStill: vi.fn(async () => ({ image: image(), hdrToneMapped: false })),
  };
  const deps: CaptureServiceDeps = {
    platform: "darwin",
    getPermission: () => "granted",
    getDisplays: () => [{ id: 1, scaleFactor: 2, colorSpace: "{primaries:BT709, transfer:SRGB}" }],
    stillEngine,
    stillEncoder: createNativeImageEncoder(),
    results: memoryResults(),
    log: { warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
  return { service: createCaptureService(deps), deps, stillEngine };
}

describe('client visibility lifecycle', () => {
  it.each(['screenshot', 'record'] as const)('hides before %s and restores only after success, cancel or failure', async kind => {
    for (const result of ['success', 'cancel', 'failure'] as const) {
      const timeline: string[] = [];
      const windowVisibility = { hide: vi.fn(async () => { timeline.push('hide'); }), restore: vi.fn(() => { timeline.push('restore'); }) };
      const run = async () => {
        timeline.push('capture'); expect(windowVisibility.restore).not.toHaveBeenCalled();
        if (result === 'failure') throw new Error('capture failure');
        if (result === 'cancel') return null;
        return kind === 'screenshot' ? { image: image(), hdrToneMapped: false }
          : { data: Buffer.from('video'), mime: 'video/mp4', width: 800, height: 600, durationMs: 1000, qualityUsed: 'standard' as const, hdrToneMapped: false };
      };
      const { service } = setup({ windowVisibility,
        stillEngine: { captureStill: run as never },
        recordEngine: { formats: () => ({ video: ['mp4'], gif: true }), record: run as never } });
      const out = await service[kind](kind === 'record' ? { output: 'mp4' } : undefined);
      expect(out).toMatchObject(result === 'success' ? { success: true } : { success: false, code: result === 'cancel' ? 'canceled' : 'failed' });
      expect(timeline).toEqual(['hide', 'capture', 'restore']); expect(service.getState()).toBe('idle');
    }
  });

  it('invalid, denied and busy calls never hide or restore another session', async () => {
    const windowVisibility = { hide: vi.fn(async () => {}), restore: vi.fn() };
    const denied = setup({ windowVisibility, getPermission: () => 'denied' });
    await denied.service.screenshot({ scale: 0 }); await denied.service.screenshot(undefined);
    expect(windowVisibility.hide).not.toHaveBeenCalled(); expect(windowVisibility.restore).not.toHaveBeenCalled();
    let ready!: () => void;
    windowVisibility.hide.mockImplementation(() => new Promise<void>(resolve => { ready = resolve; }));
    const active = setup({ windowVisibility });
    const pending = active.service.screenshot(undefined);
    expect(await active.service.screenshot(undefined)).toMatchObject({ code: 'busy' });
    expect(windowVisibility.hide).toHaveBeenCalledOnce(); expect(windowVisibility.restore).not.toHaveBeenCalled();
    active.service.cancel(); ready();
    expect(await pending).toMatchObject({ code: 'canceled' });
    expect(active.stillEngine.captureStill).not.toHaveBeenCalled(); expect(windowVisibility.restore).toHaveBeenCalledOnce();
  });
});

describe('recording duration preferences', () => {
  it('uses the saved maximum for every request and only allows callers to shorten it', async () => {
    let maximum = 30 * 60_000;
    const record = vi.fn(async (..._args: unknown[]) => null);
    const { service } = setup({ getRecordingDurationLimit: () => maximum,
      recordEngine: { formats: () => ({ video: ['mp4'], gif: true }), record } });
    await service.record({ output: 'mp4' });
    expect(record.mock.calls[0][0]).toMatchObject({ maxDurationMs: 1_800_000 });
    await service.record({ output: 'mp4', maxDurationMs: 60 * 60_000 });
    expect(record.mock.calls[1][0]).toMatchObject({ maxDurationMs: 1_800_000 });
    await service.record({ output: 'mp4', maxDurationMs: 10_000 });
    expect(record.mock.calls[2][0]).toMatchObject({ maxDurationMs: 10_000 });
    maximum = 45 * 60_000;
    await service.record({ output: 'gif' });
    expect(record.mock.calls[3][0]).toMatchObject({ maxDurationMs: 2_700_000 });
  });
});

describe("screenshot", () => {
  it("非法参数：invalid-argument，且引擎不被调用", async () => {
    const { service, stillEngine } = setup();
    const out = await service.screenshot({ scale: 0.5 });
    expect(out).toMatchObject({ success: false, code: "invalid-argument" });
    expect(stillEngine.captureStill).not.toHaveBeenCalled();
  });

  it("当前编码器不支持的格式（webp）：unsupported", async () => {
    const { service } = setup();
    expect(await service.screenshot({ format: "webp" })).toMatchObject({ success: false, code: "unsupported" });
  });

  it("平台不支持：unsupported，capabilities.available=false", async () => {
    const { service } = setup({ platform: "freebsd" });
    expect(service.getCapabilities().available).toBe(false);
    expect(await service.screenshot(undefined)).toMatchObject({ success: false, code: "unsupported" });
  });
  it('Linux screenshot capability is available without a video encoder', async () => {
    const { service } = setup({ platform: 'linux' });
    expect(service.getCapabilities()).toMatchObject({ available: true, platform: 'linux' });
    expect(await service.screenshot(undefined)).toMatchObject({ success: true });
  });
  it('an explicitly disabled backend is unavailable and never invokes any capture engine', async () => {
    const recordEngine = { formats:vi.fn(() => ({video:[],gif:false})),record:vi.fn(async () => null) };
    const {service, stillEngine} = setup({ platform:'linux',backendAvailable:() => false,recordEngine });
    expect(service.getCapabilities()).toMatchObject({available:false});
    recordEngine.formats.mockClear();
    expect(await service.screenshot({format:'png'})).toMatchObject({success:false,code:'unsupported'});
    expect(await service.record({output:'mp4'})).toMatchObject({success:false,code:'unsupported'});
    expect(stillEngine.captureStill).not.toHaveBeenCalled();
    expect(recordEngine.formats).not.toHaveBeenCalled(); expect(recordEngine.record).not.toHaveBeenCalled();
  });

  it.each(["denied", "not-determined"] as const)("权限 %s：进入引导，引擎不被调用", async permission => {
    const { service, stillEngine } = setup({ getPermission: () => permission });
    expect(await service.screenshot(undefined)).toMatchObject({ success: false, code: "permission-denied" });
    expect(stillEngine.captureStill).not.toHaveBeenCalled();
  });

  it("权限被拒绝时触发授权引导，结果照常立即返回；已授权不触发", async () => {
    const onPermissionDenied = vi.fn();
    const denied = setup({ getPermission: () => "denied", onPermissionDenied });
    expect(await denied.service.screenshot(undefined)).toMatchObject({ success: false, code: "permission-denied" });
    expect(onPermissionDenied).toHaveBeenCalledOnce();
    const granted = setup({ getPermission: () => "granted", onPermissionDenied });
    await granted.service.screenshot(undefined);
    expect(onPermissionDenied).toHaveBeenCalledOnce();
  });

  it("成功：状态流转、字节可经 readChunk 取回、release 后取不到", async () => {
    const { service } = setup();
    const states: CaptureState[] = [];
    service.onStateChange((s) => states.push(s));
    const out = await service.screenshot({ format: "png" });
    expect(out).toMatchObject({
      success: true,
      mime: "image/png",
      width: 800,
      height: 600,
      qualityUsed: "lossless",
      hdrToneMapped: false,
    });
    expect(states).toEqual(["selecting", "encoding", "idle"]);
    if (!out.success) throw new Error("unreachable");
    expect(service.readChunk(out.resultId, 0, 1000)!.toString()).toBe("PNGDATA-0123456789");
    service.release(out.resultId);
    expect(service.readChunk(out.resultId, 0, 10)).toBeNull();
  });

  it("用户取消（引擎返回 null）：canceled，不产生结果，状态回到 idle", async () => {
    const { service } = setup({}, { captureStill: async () => null });
    expect(await service.screenshot(undefined)).toEqual({ success: false, code: "canceled" });
    expect(service.getState()).toBe("idle");
  });

  it("调用方 cancel()：引擎观察到 abort，结果为 canceled", async () => {
    let release!: () => void;
    const engine: StillEngine = {
      captureStill: (signal) =>
        new Promise((resolve) => {
          release = () => resolve({ image: image(), hdrToneMapped: false });
          signal.addEventListener("abort", () => resolve({ image: image(), hdrToneMapped: false }));
        }),
    };
    const { service } = setup({}, engine);
    const pending = service.screenshot(undefined);
    expect(service.getState()).toBe("selecting");
    service.cancel();
    expect(await pending).toEqual({ success: false, code: "canceled" });
    expect(release).toBeTypeOf("function");
  });

  it("busy：会话进行中第二次调用被拒绝，结束后可再次发起", async () => {
    let finish!: () => void;
    const engine: StillEngine = {
      captureStill: () =>
        new Promise((resolve) => {
          finish = () => resolve({ image: image(), hdrToneMapped: false });
        }),
    };
    const { service } = setup({}, engine);
    const first = service.screenshot(undefined);
    expect(await service.screenshot(undefined)).toMatchObject({ success: false, code: "busy" });
    finish();
    expect((await first).success).toBe(true);
    const second = service.screenshot(undefined);
    finish();
    expect((await second).success).toBe(true);
  });

  it("引擎抛错：failed，状态回到 idle，错误被记录", async () => {
    const { service, deps } = setup({}, {
      captureStill: async () => {
        throw new Error("grab failed");
      },
    });
    expect(await service.screenshot(undefined)).toEqual({ success: false, code: "failed", error: "grab failed" });
    expect(service.getState()).toBe("idle");
    expect(deps.log.error).toHaveBeenCalled();
  });

  it("maxBytes 下探：qualityUsed 降低；最低档仍超限则标记 exceedsMaxBytes", async () => {
    const { service } = setup();
    const fits = await service.screenshot({ format: "jpeg", compression: { quality: "high", maxBytes: 800 } });
    expect(fits).toMatchObject({ success: true, qualityUsed: "low" });
    expect(fits.success && fits.exceedsMaxBytes).toBeFalsy();
    const over = await service.screenshot({ format: "jpeg", compression: { quality: "high", maxBytes: 10 } });
    expect(over).toMatchObject({ success: true, qualityUsed: "low", exceedsMaxBytes: true });
  });

  it("HDR 屏采集：hdrToneMapped 透传", async () => {
    const { service } = setup({}, { captureStill: async () => ({ image: image(), hdrToneMapped: true }) });
    expect(await service.screenshot({ format: "png" })).toMatchObject({ success: true, hdrToneMapped: true });
  });

  it("尺寸不变：成功结果的宽高等于采集图宽高", async () => {
    const { service } = setup({}, { captureStill: async () => ({ image: image(1921, 1081), hdrToneMapped: false }) });
    for (const quality of ["lossless", "high", "medium", "low"] as const) {
      const out = await service.screenshot({ compression: { quality, maxBytes: 1 } });
      expect(out).toMatchObject({ success: true, width: 1921, height: 1081 });
    }
  });
});

describe("endSession", () => {
  it("清空全部结果，并中止进行中的会话", async () => {
    const { service } = setup();
    const done = await service.screenshot({ format: "png" });
    if (!done.success) throw new Error("unreachable");
    service.endSession();
    expect(service.readChunk(done.resultId, 0, 1)).toBeNull();

    const engine: StillEngine = {
      captureStill: (signal) =>
        new Promise((resolve) => signal.addEventListener("abort", () => resolve(null))),
    };
    const { service: s2 } = setup({}, engine);
    const pending = s2.screenshot(undefined);
    s2.endSession();
    expect(await pending).toEqual({ success: false, code: "canceled" });
  });
});

describe("capabilities", () => {
  it("如实反映当前能力：只有静态图格式，视频/GIF 未提供", () => {
    const { service } = setup();
    const caps = service.getCapabilities();
    expect(caps).toMatchObject({
      apiVersion: 1,
      available: true,
      platform: "darwin",
      permission: "granted",
      formats: { still: ["png", "jpeg"], video: [], gif: false },
    });
    expect(caps.displays).toEqual([{ id: "1", hdr: false, scale: 2 }]);
    expect(Object.keys(caps.tiers)).toEqual(["lossless", "high", "medium", "low"]);
  });
});

describe("record", () => {
  it("cleans the engine file when transferring a completed recording fails", async () => {
    const disposeFile = vi.fn();
    const { service } = setup({ recordEngine: {
      formats: () => ({ video: ["webm"], gif: false }),
      record: async () => ({ filePath: "/private/record.webm", disposeFile, mime: "video/webm", width: 20, height: 10,
        durationMs: 100, qualityUsed: "high", hdrToneMapped: false }),
    } });
    expect(await service.record({ output: "webm" })).toMatchObject({ success: false, code: "failed" });
    expect(disposeFile).toHaveBeenCalledOnce();
    expect(service.getState()).toBe("idle");
  });
  it("参数校验先于一切", async () => {
    const { service } = setup();
    expect(await service.record({ output: "avi" })).toMatchObject({ success: false, code: "invalid-argument" });
  });

  it("没有录制引擎：unsupported", async () => {
    const { service } = setup();
    expect(await service.record({ output: "mp4" })).toMatchObject({ success: false, code: "unsupported" });
  });

  it("引擎不支持该输出：encoder-unavailable", async () => {
    const { service } = setup({
      recordEngine: { formats: () => ({ video: ["webm"], gif: false }), record: vi.fn() },
    });
    expect(await service.record({ output: "mp4" })).toMatchObject({ success: false, code: "encoder-unavailable" });
    expect(await service.record({ output: "gif" })).toMatchObject({ success: false, code: "encoder-unavailable" });
  });

  it("录制成功：结果入库并带上时长；状态由引擎回调驱动", async () => {
    const states: CaptureState[] = [];
    const { service } = setup({
      recordEngine: {
        formats: () => ({ video: ["mp4"], gif: true }),
        record: async (_o, _s, onState) => {
          onState("recording");
          onState("encoding");
          return {
            data: Buffer.from("VIDEO"),
            mime: "video/mp4",
            width: 1280,
            height: 720,
            durationMs: 4200,
            qualityUsed: "medium",
            hdrToneMapped: false,
          };
        },
      },
    });
    service.onStateChange((s) => states.push(s));
    const out = await service.record({ output: "mp4" });
    expect(out).toMatchObject({ success: true, mime: "video/mp4", durationMs: 4200, width: 1280, qualityUsed: "medium" });
    expect(states).toEqual(["selecting", "recording", "encoding", "idle"]);
  });
});
