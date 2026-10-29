import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindUiStatusActivity, createUiStatusPoller } from "./uiStatusPoller";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("UI status query lifecycle", () => {
  it("慢 IPC 不叠加自动查询，结束后才启动下一轮五秒计时", async () => {
    const first = deferred();
    const request = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const poller = createUiStatusPoller(request);
    poller.start();
    await flush();
    await vi.advanceTimersByTimeAsync(20000);
    expect(request).toHaveBeenCalledOnce();
    first.resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(4999);
    expect(request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(2);
    poller.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("服务动作后的手动刷新排新查询，多次点击合并等待同一个新结果", async () => {
    const beforeAction = deferred();
    const afterAction = deferred();
    const request = vi.fn().mockReturnValueOnce(beforeAction.promise).mockReturnValueOnce(afterAction.promise);
    const poller = createUiStatusPoller(request);
    poller.start();
    await flush();
    const firstRefresh = poller.refresh();
    const secondRefresh = poller.refresh();
    expect(firstRefresh).toBe(secondRefresh);
    let fresh = false;
    void firstRefresh.then(() => { fresh = true; });
    expect(request).toHaveBeenCalledOnce();
    beforeAction.resolve();
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(fresh).toBe(false);
    afterAction.resolve();
    await firstRefresh;
    expect(fresh).toBe(true);
    poller.dispose();
  });

  it("隐藏冷启动不查询，恢复立即补查；在途期间再次隐藏不会复活自动查询", async () => {
    const pending = deferred();
    const request = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
    const poller = createUiStatusPoller(request);
    poller.setVisible(false);
    poller.start();
    await vi.advanceTimersByTimeAsync(60000);
    expect(request).not.toHaveBeenCalled();
    poller.setVisible(true);
    await flush();
    expect(request).toHaveBeenCalledOnce();
    poller.setVisible(false);
    poller.setVisible(true); // 要求旧请求结束后补查。
    poller.setVisible(false); // 自动补查在发出前再次失活。
    pending.resolve();
    await vi.advanceTimersByTimeAsync(60000);
    expect(request).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    poller.setVisible(true);
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    poller.dispose();
  });

  it("隐藏期间保留明确的手动刷新，在途响应仍可更新当前实例", async () => {
    const pending = deferred();
    const applied = vi.fn();
    const request = vi.fn(async (isCurrent: () => boolean) => {
      if (request.mock.calls.length === 1) await pending.promise;
      if (isCurrent()) applied();
    });
    const poller = createUiStatusPoller(request);
    poller.start();
    await flush();
    poller.setVisible(false);
    const manual = poller.refresh();
    pending.resolve();
    await manual;
    expect(request).toHaveBeenCalledTimes(2);
    expect(applied).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    poller.dispose();
  });

  it("卸载后拒绝迟到更新和 timer，StrictMode 再挂载等待旧请求后补查", async () => {
    const oldInstance = deferred();
    const applied = vi.fn();
    const request = vi.fn(async (isCurrent: () => boolean) => {
      if (request.mock.calls.length === 1) await oldInstance.promise;
      if (isCurrent()) applied();
    });
    const poller = createUiStatusPoller(request);
    poller.start();
    await flush();
    poller.dispose();
    poller.resume();
    poller.start();
    await flush();
    expect(request).toHaveBeenCalledOnce();
    oldInstance.resolve();
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(applied).toHaveBeenCalledOnce();
    poller.dispose();
    await vi.advanceTimersByTimeAsync(60000);
    await poller.refresh();
    expect(request).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("单次异常释放在途锁，自动周期与动作后补查仍可继续", async () => {
    const failed = deferred();
    const request = vi.fn().mockReturnValueOnce(failed.promise).mockResolvedValue(undefined);
    const poller = createUiStatusPoller(request);
    poller.start();
    await flush();
    const manual = poller.refresh();
    failed.reject(new Error("IPC disconnected"));
    await manual;
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(request).toHaveBeenCalledTimes(3);
    poller.dispose();
  });
});

function activityFixture(visibilityState: DocumentVisibilityState = "visible") {
  let listener: ((payload: unknown) => void) | null = null;
  const documentListeners = new Map<string, () => void>();
  const documentSource = {
    visibilityState,
    addEventListener: vi.fn((name: string, cb: () => void) => documentListeners.set(name, cb)),
    removeEventListener: vi.fn((name: string) => documentListeners.delete(name)),
  };
  return {
    documentSource: documentSource as unknown as Document,
    subscribe(cb: (payload: unknown) => void) {
      listener = cb;
      return () => { listener = null; };
    },
    emit(visible: boolean) { listener?.({ visible }); },
    documentVisibility(next: DocumentVisibilityState) {
      documentSource.visibilityState = next;
      documentListeners.get("visibilitychange")?.();
    },
    listeners: () => documentListeners.size,
  };
}

describe("shell host activity subscription", () => {
  it("文档显示但宿主初态隐藏/锁屏时，等待快照后不发自动查询", async () => {
    const request = vi.fn(async () => undefined);
    const poller = createUiStatusPoller(request);
    const fixture = activityFixture();
    const cleanup = bindUiStatusActivity(poller, {
      subscribe: fixture.subscribe,
      getSnapshot: async () => ({ visible: false }),
    }, fixture.documentSource);
    await vi.advanceTimersByTimeAsync(60000);
    expect(request).not.toHaveBeenCalled();
    fixture.emit(true);
    await flush();
    expect(request).toHaveBeenCalledOnce();
    fixture.documentVisibility("hidden"); // 宿主已有事实源，文档信号不会覆盖。
    await vi.advanceTimersByTimeAsync(5000);
    expect(request).toHaveBeenCalledTimes(2);
    cleanup();
    poller.dispose();
    expect(fixture.listeners()).toBe(0);
  });

  it("订阅后的隐藏事件优先于迟到的可见快照", async () => {
    let resolve!: (value: { visible: boolean }) => void;
    const snapshot = new Promise<{ visible: boolean }>((done) => { resolve = done; });
    const request = vi.fn(async () => undefined);
    const poller = createUiStatusPoller(request);
    const fixture = activityFixture();
    const cleanup = bindUiStatusActivity(poller, {
      subscribe: fixture.subscribe,
      getSnapshot: () => snapshot,
    }, fixture.documentSource);
    fixture.emit(false);
    resolve({ visible: true });
    await vi.advanceTimersByTimeAsync(60000);
    expect(request).not.toHaveBeenCalled();
    cleanup();
    poller.dispose();
  });

  it.each(["missing", "rejected"])("旧宿主/%s snapshot 按浏览器文档隐藏/恢复", async (mode) => {
    const request = vi.fn(async () => undefined);
    const poller = createUiStatusPoller(request);
    const fixture = activityFixture("hidden");
    const cleanup = bindUiStatusActivity(poller, {
      subscribe: fixture.subscribe,
      ...(mode === "rejected" ? { getSnapshot: async () => { throw new Error("old IPC"); } } : {}),
    }, fixture.documentSource);
    await vi.advanceTimersByTimeAsync(60000);
    expect(request).not.toHaveBeenCalled();
    fixture.documentVisibility("visible");
    await flush();
    expect(request).toHaveBeenCalledOnce();
    cleanup();
    poller.dispose();
  });

  it("快照未返回即卸载，不启动查询且释放宿主/文档订阅", async () => {
    let resolve!: (value: { visible: boolean }) => void;
    const snapshot = new Promise<{ visible: boolean }>((done) => { resolve = done; });
    const request = vi.fn(async () => undefined);
    const poller = createUiStatusPoller(request);
    const fixture = activityFixture();
    const cleanup = bindUiStatusActivity(poller, {
      subscribe: fixture.subscribe,
      getSnapshot: () => snapshot,
    }, fixture.documentSource);
    cleanup();
    fixture.emit(true);
    resolve({ visible: true });
    await vi.advanceTimersByTimeAsync(60000);
    expect(request).not.toHaveBeenCalled();
    expect(fixture.listeners()).toBe(0);
    poller.dispose();
  });
});
