interface DockApp {
  setActivationPolicy?: (policy: "regular") => void;
  dock?: {
    isVisible?: () => boolean;
    show: () => Promise<void> | void;
  };
}

/** 恢复 Dock 不抢前台焦点；异步显示失败保留原因，后续生命周期事件可再试。 */
export function createDockVisibility(options: {
  app: DockApp;
  platform: string;
  isQuitting: () => boolean;
  log: { info: (message: string, data: object) => void; warn: (message: string, data: object) => void };
}) {
  let pending: Promise<void> | undefined;
  const warn = (reason: string) => options.log.warn("[Dock] Visibility recovery failed", { reason });
  function ensure(reason: string): void {
    if (options.platform !== "darwin" || options.isQuitting()) return;
    try {
      options.app.setActivationPolicy?.("regular");
      const dock = options.app.dock;
      if (!dock || dock.isVisible?.() === true || pending) return;
      pending = Promise.resolve()
        .then(() => {
          if (!options.isQuitting()) return dock.show();
        })
        .then(() => {
          if (options.isQuitting()) return;
          const visible = dock.isVisible?.();
          if (visible === false) warn(reason);
          else options.log.info("[Dock] Visibility recovered", { reason, visible: visible ?? "unknown" });
        })
        .catch(() => warn(reason))
        .finally(() => { pending = undefined; });
    } catch {
      warn(reason);
    }
  }
  return { ensure };
}
