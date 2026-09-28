/**
 * UI 状态查询的资源归属：一条在途请求、至多一条待补查，以及一个下次查询 timer。
 * 隐藏只暂停自动查询；手动刷新仍补查动作后的状态。必要服务/任务连接由主进程管理。
 */
export function createUiStatusPoller(
  request: (isCurrent: () => boolean) => Promise<void>,
  intervalMs = 5000,
) {
  let active = true;
  let generation = 0;
  let background = false;
  let visible = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: { generation: number; promise: Promise<void> } | null = null;
  let queued: {
    generation: number;
    automaticOnly: boolean;
    promise: Promise<void>;
  } | null = null;

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const isCurrent = (captured: number) => active && generation === captured;

  function schedule(): void {
    if (!active || !background || !visible || inFlight || queued || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      automaticRefresh(false);
    }, intervalMs);
  }

  function query(): Promise<void> {
    if (!active) return Promise.resolve();
    if (inFlight) return inFlight.promise;
    clearTimer();
    const captured = generation;
    const record = {
      generation: captured,
      promise: Promise.resolve().then(() => {
        if (!isCurrent(captured)) return;
        return request(() => isCurrent(captured));
      }),
    };
    inFlight = record;
    const release = () => {
      if (inFlight === record) inFlight = null;
      schedule();
    };
    // 同时处理 reject，自动查询失败后仍按原有周期重试，清理链不会产生未处理异常。
    record.promise.then(release, release);
    return record.promise;
  }

  function enqueueRefresh(automaticOnly: boolean): Promise<void> {
    if (queued && queued.generation === generation) {
      if (!automaticOnly) queued.automaticOnly = false;
      return queued.promise;
    }
    const previous = inFlight!.promise;
    const record = {
      generation,
      automaticOnly,
      promise: Promise.resolve(),
    };
    const next = () => {
      if (queued === record) queued = null;
      if (!isCurrent(record.generation)) return;
      // 恢复期间排队的自动补查若再次隐藏则取消；用户动作的补查继续执行。
      if (record.automaticOnly && (!background || !visible)) return;
      return query();
    };
    record.promise = previous.then(next, next);
    queued = record;
    return record.promise;
  }

  function automaticRefresh(fresh: boolean): void {
    if (!active || !background || !visible) return;
    const pending = inFlight && (fresh || inFlight.generation !== generation)
      ? enqueueRefresh(true)
      : query();
    void pending.catch(() => undefined);
  }

  return {
    /** 手动刷新不复用动作前的在途结果；并发刷新合并为结束后的一次新查询。 */
    refresh(): Promise<void> {
      if (!active) return Promise.resolve();
      return inFlight ? enqueueRefresh(false) : query();
    },
    start(): void {
      if (background) return;
      background = true;
      automaticRefresh(false);
    },
    stop(): void {
      background = false;
      clearTimer();
    },
    setVisible(next: boolean): void {
      if (visible === next) return;
      visible = next;
      if (!next) clearTimer();
      else automaticRefresh(true);
    },
    /** React StrictMode 再挂载沿：沿用在途资源，等待旧代次结束后再补查。 */
    resume(): void {
      active = true;
    },
    dispose(): void {
      active = false;
      generation += 1;
      background = false;
      queued = null;
      clearTimer();
    },
  };
}

interface HostActivitySource {
  getSnapshot?: () => Promise<{ visible: boolean } | null>;
  subscribe(listener: (payload: unknown) => void): () => void;
}

/** 订阅先于快照；新事件使迟到快照失效。旧宿主/浏览器按文档可见性查询。 */
export function bindUiStatusActivity(
  poller: Pick<ReturnType<typeof createUiStatusPoller>, "setVisible" | "start" | "stop">,
  source: HostActivitySource,
  documentSource: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">,
): () => void {
  let disposed = false;
  let eventVersion = 0;
  let hostActivityAvailable = !!source.getSnapshot;
  const documentVisible = () => documentSource.visibilityState !== "hidden";
  const onDocumentVisibility = () => {
    if (!hostActivityAvailable) poller.setVisible(documentVisible());
  };
  const unsubscribe = source.subscribe((payload) => {
    const activity = payload as { visible?: unknown } | null;
    if (disposed || typeof activity?.visible !== "boolean") return;
    eventVersion += 1;
    hostActivityAvailable = true;
    poller.setVisible(activity.visible);
  });
  documentSource.addEventListener("visibilitychange", onDocumentVisibility);
  const capturedVersion = eventVersion;
  void (async () => {
    try {
      const snapshot = await source.getSnapshot?.();
      if (disposed || eventVersion !== capturedVersion) return;
      hostActivityAvailable = typeof snapshot?.visible === "boolean";
      poller.setVisible(hostActivityAvailable ? snapshot!.visible : documentVisible());
    } catch {
      if (!disposed && eventVersion === capturedVersion) {
        hostActivityAvailable = false;
        poller.setVisible(documentVisible());
      }
    } finally {
      if (!disposed) poller.start();
    }
  })();
  return () => {
    disposed = true;
    unsubscribe();
    documentSource.removeEventListener("visibilitychange", onDocumentVisibility);
    poller.stop();
  };
}
