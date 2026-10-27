import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CAPTURE_IPC, HOST_CAPTURE_IPC, HOST_CAPTURE_SAVE_IPC, CAPTURE_INTERACTIVE_IPC, type CaptureResult } from '@shared/features/capture/contract';
import { createTrustedIpc } from '../_kit/trustedIpc';
import { createFeatureLifecycle } from '../_kit/lifecycle';
import type { FeatureContext, FeatureHandle } from '../_kit/types';
import type { RecordCapture, StillCapture } from './captureService';

const mocks = vi.hoisted(() => {
  const emitter = () => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    return {
      on: vi.fn((name: string, listener: (...args: unknown[]) => void) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(listener); }),
      removeListener: vi.fn((name: string, listener: (...args: unknown[]) => void) => { listeners.get(name)?.delete(listener); }),
      emit(name: string, ...args: unknown[]) { for (const listener of listeners.get(name) ?? []) listener(...args); },
      clear() { listeners.clear(); },
    };
  };
  const data = new Map<string, Buffer>();
  let sequence = 0;
  return {
    power: emitter(), screen: emitter(), data,
    captureStill: vi.fn(), record: vi.fn(), resolveFfmpeg: vi.fn(), showSaveDialog: vi.fn(), setActions: vi.fn(),
    windowDispose: vi.fn(), recorderDispose: vi.fn(), recorderStop: vi.fn(),
    copyTo: vi.fn(() => true), release: vi.fn((id: string) => { data.delete(id); }),
    copy: vi.fn(), fromWebContents: vi.fn(),
    releaseAll: vi.fn(() => { data.clear(); }),
    put: vi.fn((bytes: Buffer, mime: string) => { const resultId = `capture-${++sequence}`; data.set(resultId, bytes); return { resultId, bytes: bytes.length, mime }; }),
    readChunk: vi.fn((id: string, offset: number, length: number) => data.get(id)?.subarray(offset, offset + length) ?? null),
  };
});
vi.mock('electron', () => ({
  app: { commandLine: { getSwitchValue: () => '' } },
  BrowserWindow: { fromWebContents: mocks.fromWebContents }, dialog: { showSaveDialog: mocks.showSaveDialog },
  powerMonitor: mocks.power, screen: mocks.screen,
}));
vi.mock('./electronDeps', () => ({ getScreenPermission: () => 'granted', getAllDisplays: () => [{ id: 1, scaleFactor: 2 }] }));
vi.mock('./encodingResources', () => ({ resolveCaptureFfmpeg: mocks.resolveFfmpeg }));
vi.mock('./selectionWindows', () => ({ createCaptureWindows: () => ({ captureStill: mocks.captureStill, setLabels: vi.fn(), setActions: mocks.setActions, dispose: mocks.windowDispose }) }));
vi.mock('./recorder', () => ({
  createCaptureSourceStill: () => vi.fn(),
  createCapturePortalFrame: () => vi.fn(),
  createRecordEngine: () => ({ formats: () => ({ video: ['mp4', 'webm'], gif: true }), record: mocks.record, stop: mocks.recorderStop, dispose: mocks.recorderDispose }),
}));
vi.mock('./results', () => ({ createResultStore: () => ({ put: mocks.put, copyTo: mocks.copyTo, readChunk: mocks.readChunk, release: mocks.release, releaseAll: mocks.releaseAll }) }));
vi.mock('./clipboard', () => ({ createCaptureClipboard: () => ({ copy: mocks.copy, dispose: vi.fn() }) }));
import { captureFeature } from './index';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
class Sender extends EventEmitter {
  destroyed = false;
  mainFrame = { url: 'https://trusted.test/app' };
  send = vi.fn();
  constructor(readonly id: number, readonly role: 'host' | 'business' | 'other') { super(); }
  isDestroyed() { return this.destroyed; }
  navigate() { this.emit('did-start-navigation', {}, 'https://trusted.test/new', false, true); this.mainFrame = { url: 'https://trusted.test/new' }; }
}
const frameEvent = (sender: Sender, frame: unknown = sender.mainFrame) => ({ sender, senderFrame: frame });
const still: StillCapture = { image: { getSize: () => ({ width: 1200, height: 800 }), toPNG: () => Buffer.from('fixture-png'), toJPEG: () => Buffer.from('fixture-jpeg') }, hdrToneMapped: false };
let handle: FeatureHandle;
let lifecycle: ReturnType<typeof createFeatureLifecycle>;
let channels: Map<string, (event: never, ...args: never[]) => unknown>;
let ctx: FeatureContext;
const host = () => new Sender(10, 'host');
const business = () => new Sender(20, 'business');
async function invoke<T = unknown>(channel: string, sender: Sender, ...args: unknown[]): Promise<T> {
  return channels.get(channel)!(frameEvent(sender) as never, ...args as never[]) as T;
}
async function capture(sender: Sender, hostChannel = false) {
  const result = await invoke<CaptureResult>(hostChannel ? HOST_CAPTURE_IPC.SCREENSHOT : CAPTURE_IPC.SCREENSHOT, sender, { format: 'png' });
  if (!result.success) throw new Error(JSON.stringify(result));
  return result;
}
// 能力门以 process.platform 判定（darwin/win32 才可用）；CI runner 为 linux，须统一钉 darwin
beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
});
beforeEach(() => {
  vi.clearAllMocks(); mocks.data.clear(); mocks.power.clear(); mocks.screen.clear();
  mocks.captureStill.mockResolvedValue(still); mocks.record.mockResolvedValue(null); mocks.resolveFfmpeg.mockResolvedValue(null);
  mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/fixture/saved.png' });
  mocks.copy.mockResolvedValue({ success: true, kind: 'image' });
  mocks.fromWebContents.mockReturnValue(null);
  channels = new Map(); lifecycle = createFeatureLifecycle();
  const ipcMain = { handle(channel: string, handler: (event: never, ...args: never[]) => unknown) { channels.set(channel, handler); }, removeHandler(channel: string) { channels.delete(channel); } };
  const trust = (role: Sender['role']) => (event: ReturnType<typeof frameEvent>) => event.sender.role === role && !event.sender.isDestroyed() && event.senderFrame === event.sender.mainFrame;
  ctx = {
    product: 'nuwax', ipc: createTrustedIpc(ipcMain, trust('business')), hostIpc: createTrustedIpc(ipcMain, trust('host')),
    lifecycle, scratch: { root: '/fixture', sweep: vi.fn(() => 0), create: vi.fn(() => '/fixture'), resolve: () => null, remove: vi.fn(), isValidId: () => true },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    dataDir: '/fixture',
    settings: { read: vi.fn(() => undefined), write: vi.fn(() => true) },
    session: { isAuthenticated: () => true },
    windows: { getMain: () => null },
    activities: { set: vi.fn() },
    agent: {
      setLocalMcpServer: async () => undefined,
      hasLocalMcpServer: () => false,
      resolveNodeBinary: () => null,
      registerSessionParticipant: () => () => {},
    },
  };
  handle = captureFeature.register(ctx);
});
afterEach(async () => { vi.restoreAllMocks(); await handle.dispose(); });

describe('native capture entry point security', () => {
  it('reveals a background shell only after successful capture and leaves canceled/business captures alone', async () => {
    const parent = { isDestroyed: () => false, isVisible: () => false, isMinimized: () => true,
      restore: vi.fn(), show: vi.fn(), focus: vi.fn() };
    mocks.fromWebContents.mockReturnValue(parent);
    const frame = deferred<StillCapture>();
    mocks.captureStill.mockReturnValueOnce(frame.promise);
    const pending = capture(business());
    await vi.waitFor(() => expect(mocks.captureStill).toHaveBeenCalledOnce());
    expect(parent.restore).not.toHaveBeenCalled();
    expect(parent.show).not.toHaveBeenCalled();
    frame.resolve(still);
    await pending;
    expect(parent.restore).toHaveBeenCalledOnce();
    expect(parent.show).toHaveBeenCalledOnce();
    expect(parent.focus).toHaveBeenCalledOnce();
    parent.show.mockClear(); parent.focus.mockClear(); parent.restore.mockClear();
    mocks.captureStill.mockResolvedValueOnce(null);
    expect(await invoke(CAPTURE_IPC.SCREENSHOT, business(), {})).toEqual({ success: false, code: 'canceled' });
    await capture(host(), true);
    expect(parent.show).not.toHaveBeenCalled();
    expect(parent.focus).not.toHaveBeenCalled();
    expect(parent.restore).not.toHaveBeenCalled();
  });

  it('only an explicit trusted interactive call enables output switching for IM', async () => {
    const sender = business();
    await capture(sender);
    expect(mocks.setActions).toHaveBeenLastCalledWith('screenshot', []);
    expect(await invoke(CAPTURE_INTERACTIVE_IPC, sender, { action: 'screenshot' })).toMatchObject({ success: true });
    expect(mocks.setActions).toHaveBeenLastCalledWith('screenshot', ['screenshot', 'mp4', 'gif']);
    const calls = mocks.setActions.mock.calls.length;
    expect(await invoke(CAPTURE_INTERACTIVE_IPC, new Sender(30, 'other'), { action: 'mp4' })).toMatchObject({ code: 'untrusted' });
    expect(await invoke(CAPTURE_INTERACTIVE_IPC, sender, { action: 'unknown' })).toMatchObject({ code: 'invalid-argument' });
    expect(mocks.setActions).toHaveBeenCalledTimes(calls);
  });
  it('opens screenshots while video resource verification is still pending', async () => {
    const init = deferred<null>(); mocks.resolveFfmpeg.mockReturnValueOnce(init.promise);
    const fullCaps = invoke(HOST_CAPTURE_IPC.GET_CAPABILITIES, host());
    await Promise.resolve();
    expect(await invoke(HOST_CAPTURE_IPC.GET_CAPABILITIES, host(), { includeRecording: false })).toMatchObject({ available: true });
    expect((await capture(business())).mime).toBe('image/png');
    expect(mocks.captureStill).toHaveBeenCalledOnce();
    init.resolve(null); await fullCaps;
    expect(mocks.resolveFfmpeg).toHaveBeenCalledOnce();
  });
  it('copy 拒绝外域、子 frame、其他页面和失效句柄，仅原结果所有者可导出', async () => {
    const sender = business(); const result = await capture(sender);
    expect(await invoke(CAPTURE_IPC.COPY, new Sender(40, 'other'), result.resultId)).toMatchObject({ code: 'untrusted' });
    expect(await channels.get(CAPTURE_IPC.COPY)!(frameEvent(sender, { ...sender.mainFrame }) as never, result.resultId as never)).toMatchObject({ code: 'untrusted' });
    expect(await invoke(CAPTURE_IPC.COPY, new Sender(21, 'business'), result.resultId)).toMatchObject({ code: 'invalid-argument' });
    expect(await invoke(HOST_CAPTURE_IPC.COPY, host(), result.resultId)).toMatchObject({ code: 'invalid-argument' });
    expect(mocks.copy).not.toHaveBeenCalled();
    expect(await invoke(CAPTURE_IPC.COPY, sender, result.resultId)).toEqual({ success: true, kind: 'image' });
    expect(mocks.copy.mock.calls[0][0]).toEqual(result); expect(mocks.copy.mock.calls[0][2]()).toBe(true);
    await invoke(CAPTURE_IPC.RELEASE, sender, result.resultId);
    expect(await invoke(CAPTURE_IPC.COPY, sender, result.resultId)).toMatchObject({ code: 'invalid-argument' });
    expect(mocks.copy).toHaveBeenCalledOnce();
  });
  it.each(['navigation', 'logout'])('copy 期间 %s 会取消子进程并使所有权检查失效', async cause => {
    const sender = business(); const result = await capture(sender); const done = deferred<unknown>();
    mocks.copy.mockReturnValueOnce(done.promise);
    const pending = invoke(CAPTURE_IPC.COPY, sender, result.resultId);
    const [, signal, isCurrent] = mocks.copy.mock.calls[0];
    if (cause === 'navigation') sender.navigate(); else lifecycle.emitSessionEnd('logout');
    expect(signal.aborted).toBe(true); expect(isCurrent()).toBe(false);
    done.resolve({ success: false, code: 'canceled' }); expect(await pending).toMatchObject({ code: 'canceled' });
  });
  it.each(['mp4', 'webm', 'gif'])('returns completed %s bytes to the IM caller without opening the standalone save flow', async (output) => {
    const b = business(), h = host(), other = new Sender(21, 'business');
    const completed = deferred<RecordCapture>();
    mocks.record.mockImplementationOnce(async (_options, _signal, state) => {
      state('recording');
      const result = await completed.promise;
      state('encoding');
      return result;
    });
    let returned = false;
    const pending = invoke<CaptureResult>(CAPTURE_IPC.RECORD, b, { output }).then(result => { returned = true; return result; });
    await vi.waitFor(() => expect(mocks.record).toHaveBeenCalledTimes(1));
    expect(returned).toBe(false);
    expect(await invoke(HOST_CAPTURE_IPC.RECORD, h, { output })).toMatchObject({ success: false, code: 'busy' });
    const bytes = Buffer.from(`encoded-${output}`);
    completed.resolve({ data: bytes, mime: output === 'gif' ? 'image/gif' : `video/${output}`,
      width: 800, height: 600, durationMs: 2500, qualityUsed: 'high', hdrToneMapped: false });
    const result = await pending;
    expect(result).toMatchObject({ success: true, bytes: bytes.length, durationMs: 2500 });
    if (!result.success) throw new Error('recording did not produce a result');
    expect(Buffer.from(await invoke<Uint8Array>(CAPTURE_IPC.READ_CHUNK, b, result.resultId, 0, bytes.length))).toEqual(bytes);
    expect(await invoke(HOST_CAPTURE_IPC.READ_CHUNK, h, result.resultId, 0, bytes.length)).toBeNull();
    expect(await invoke(CAPTURE_IPC.READ_CHUNK, other, result.resultId, 0, bytes.length)).toBeNull();
    expect(b.send.mock.calls.map(call => call[1])).toEqual(['selecting', 'recording', 'encoding', 'idle']);
    expect(h.send).not.toHaveBeenCalled(); expect(other.send).not.toHaveBeenCalled();
    expect(mocks.showSaveDialog).not.toHaveBeenCalled();
    await invoke(CAPTURE_IPC.RELEASE, b, result.resultId);
    expect(await invoke(CAPTURE_IPC.READ_CHUNK, b, result.resultId, 0, bytes.length)).toBeNull();
  });
  it('keeps host and business trust separate and refuses subframes before initializing resources', async () => {
    const h = host(), b = business(), outsider = new Sender(30, 'other');
    expect(await invoke(HOST_CAPTURE_IPC.SCREENSHOT, b, {})).toEqual({ success: false, code: 'untrusted' });
    expect(await invoke(CAPTURE_IPC.SCREENSHOT, h, {})).toEqual({ success: false, code: 'untrusted' });
    expect(await invoke(CAPTURE_IPC.RECORD, outsider, {})).toEqual({ success: false, code: 'untrusted' });
    expect(await channels.get(CAPTURE_IPC.SCREENSHOT)!(frameEvent(b, { url: b.mainFrame.url }) as never, {} as never)).toEqual({ success: false, code: 'untrusted' });
    expect(await invoke(HOST_CAPTURE_SAVE_IPC, b, 'unknown')).toEqual({ success: false, error: 'untrusted sender' });
    expect(mocks.resolveFfmpeg).not.toHaveBeenCalled(); expect(mocks.captureStill).not.toHaveBeenCalled();
    await capture(h, true); await capture(b);
    expect(h.send).toHaveBeenCalledWith(HOST_CAPTURE_IPC.STATE_CHANGED, 'selecting');
    expect(b.send).toHaveBeenCalledWith(CAPTURE_IPC.STATE_CHANGED, 'selecting');
  });
  it('owns results by sender and rejects read/release/save across pages', async () => {
    const first = business(), second = new Sender(21, 'business'), h = host();
    const result = await capture(first);
    expect(await invoke(CAPTURE_IPC.READ_CHUNK, second, result.resultId, 0, 100)).toBeNull();
    expect(await invoke(HOST_CAPTURE_IPC.READ_CHUNK, h, result.resultId, 0, 100)).toBeNull();
    await invoke(CAPTURE_IPC.RELEASE, second, result.resultId);
    expect(mocks.release).not.toHaveBeenCalled();
    expect(await invoke(HOST_CAPTURE_SAVE_IPC, h, result.resultId)).toEqual({ success: false, error: 'capture result expired' });
    expect(mocks.showSaveDialog).not.toHaveBeenCalled();
    expect(Buffer.from(await invoke<Uint8Array>(CAPTURE_IPC.READ_CHUNK, first, result.resultId, 0, 100)).toString()).toBe('fixture-png');
    await invoke(CAPTURE_IPC.RELEASE, first, result.resultId);
    expect(await invoke(CAPTURE_IPC.READ_CHUNK, first, result.resultId, 0, 100)).toBeNull();
  });
  it('allows only the active owner to cancel, and an owner cancellation prevents any stored output', async () => {
    const first = business(), second = new Sender(21, 'business');
    const started = deferred<AbortSignal>();
    mocks.captureStill.mockImplementationOnce((signal: AbortSignal) => { started.resolve(signal); return new Promise(resolve => signal.addEventListener('abort', () => resolve(still), { once: true })); });
    const pending = invoke(CAPTURE_IPC.SCREENSHOT, first, {});
    const signal = await started.promise;
    await invoke(CAPTURE_IPC.CANCEL, second); expect(signal.aborted).toBe(false);
    await invoke(CAPTURE_IPC.CANCEL, first); expect(signal.aborted).toBe(true);
    expect(await pending).toEqual({ success: false, code: 'canceled' }); expect(mocks.put).not.toHaveBeenCalled();
  });
  it.each(['lock-screen', 'suspend', 'display-removed', 'logout', 'switch-domain'])('%s cancels a pending capture and clears existing results', async (reason) => {
    const sender = business(); const result = await capture(sender);
    const started = deferred<AbortSignal>();
    mocks.captureStill.mockImplementationOnce((signal: AbortSignal) => { started.resolve(signal); return new Promise(resolve => signal.addEventListener('abort', () => resolve(still), { once: true })); });
    const pending = invoke(CAPTURE_IPC.SCREENSHOT, sender, {}); const signal = await started.promise;
    if (reason === 'display-removed') mocks.screen.emit(reason);
    else if (reason === 'logout' || reason === 'switch-domain') lifecycle.emitSessionEnd(reason);
    else mocks.power.emit(reason);
    expect(signal.aborted).toBe(true); expect(await pending).toEqual({ success: false, code: 'canceled' });
    expect(await invoke(CAPTURE_IPC.READ_CHUNK, sender, result.resultId, 0, 100)).toBeNull(); expect(mocks.data.size).toBe(0);
  });
  it('navigation cancels an active capture and releases that document results', async () => {
    const sender = business(); const result = await capture(sender); const started = deferred<AbortSignal>();
    mocks.captureStill.mockImplementationOnce((signal: AbortSignal) => { started.resolve(signal); return new Promise(resolve => signal.addEventListener('abort', () => resolve(still), { once: true })); });
    const pending = invoke(CAPTURE_IPC.SCREENSHOT, sender, {}); const signal = await started.promise;
    sender.navigate(); expect(signal.aborted).toBe(true); expect(await pending).toEqual({ success: false, code: 'canceled' });
    expect(mocks.data.has(result.resultId)).toBe(false);
  });
  it('does not continue capture after the login generation changes during async initialization', async () => {
    const init = deferred<null>(); mocks.resolveFfmpeg.mockReturnValueOnce(init.promise);
    const pending = invoke(CAPTURE_IPC.SCREENSHOT, business(), {});
    await Promise.resolve(); lifecycle.emitSessionEnd('switch-domain'); init.resolve(null);
    expect(await pending).toEqual({ success: false, code: 'canceled' }); expect(mocks.captureStill).not.toHaveBeenCalled();
  });
  it('does not capture for a document that navigated while resources initialized', async () => {
    const init = deferred<null>(); mocks.resolveFfmpeg.mockReturnValueOnce(init.promise);
    const sender = business(); const pending = invoke(CAPTURE_IPC.SCREENSHOT, sender, {});
    await Promise.resolve(); sender.navigate(); init.resolve(null);
    expect(await pending).toEqual({ success: false, code: 'canceled' }); expect(mocks.captureStill).not.toHaveBeenCalled();
  });
  it.each(['release', 'session', 'navigation'])('rechecks result ownership after a save dialog when %s expires it', async (cause) => {
    const sender = host(); const result = await capture(sender, true); const saved = deferred<{ canceled: boolean; filePath: string }>();
    mocks.showSaveDialog.mockReturnValueOnce(saved.promise);
    const pending = invoke(HOST_CAPTURE_SAVE_IPC, sender, result.resultId);
    await Promise.resolve();
    if (cause === 'release') await invoke(HOST_CAPTURE_IPC.RELEASE, sender, result.resultId);
    else if (cause === 'session') lifecycle.emitSessionEnd('logout');
    else sender.navigate();
    saved.resolve({ canceled: false, filePath: '/fixture/destination.png' });
    expect(await pending).toEqual({ success: false, error: 'capture result expired' }); expect(mocks.copyTo).not.toHaveBeenCalled();
  });
  it('saves only a still-owned result and treats dialog cancellation as normal', async () => {
    const sender = host(); const result = await capture(sender, true);
    expect(await invoke(HOST_CAPTURE_SAVE_IPC, sender, result.resultId)).toEqual({ success: true });
    expect(mocks.copyTo).toHaveBeenCalledWith(result.resultId, '/fixture/saved.png');
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: true });
    expect(await invoke(HOST_CAPTURE_SAVE_IPC, sender, result.resultId)).toEqual({ success: false, canceled: true });
  });
  it('unregisters both entry points and disposes native resources', async () => {
    await capture(business()); await invoke(HOST_CAPTURE_IPC.GET_CAPABILITIES, host()); await handle.dispose();
    expect(channels.size).toBe(0); expect(mocks.windowDispose).toHaveBeenCalled(); expect(mocks.recorderDispose).toHaveBeenCalled();
    expect(mocks.data.size).toBe(0);
  });
});
