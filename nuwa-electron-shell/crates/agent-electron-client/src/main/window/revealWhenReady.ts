/** revealWhenReady 只依赖这组事件接口，便于用假窗口验证显示时机。 */
interface RevealableWindow {
  once(event: "ready-to-show", listener: () => void): unknown;
  once(event: "closed", listener: () => void): unknown;
  removeListener(event: "closed", listener: () => void): unknown;
  isDestroyed(): boolean;
  webContents: {
    once(event: "did-finish-load", listener: () => void): unknown;
    removeListener(event: "did-finish-load", listener: () => void): unknown;
  };
}

export type RevealFallback = "did-finish-load" | "timeout";

export interface RevealWhenReadyOptions {
  /** 页面加载完成后再等这么久才允许兜底显示；正常情况下 ready-to-show 更早，不会用到。 */
  loadGraceMs?: number;
  /** 创建窗口后的硬上限：加载事件也不来（加载失败等）时窗口同样不会一直不可见。 */
  timeoutMs?: number;
  /** 页面已经加载完成（例如注册前 loadURL 已 resolve）时为 true：宽限从现在起算，不再等加载事件。 */
  pageLoaded?: boolean;
  /** 由兜底而非 ready-to-show 触发显示时回调，用于日志定位。 */
  onFallback?: (fallback: RevealFallback) => void;
}

/**
 * 显示以 show:false 创建的窗口：首帧就绪（ready-to-show）即显示，且只显示一次。
 *
 * Wayland 下隐藏窗口没有合成器表面，ready-to-show 可能永不触发（electron/electron#48859），
 * 只等它会让窗口一直不可见。因此页面加载完成（加宽限）或到达硬上限时同样显示，谁先到算谁。
 */
export function revealWhenReady(
  win: RevealableWindow,
  reveal: () => void,
  options: RevealWhenReadyOptions = {},
): void {
  const loadGraceMs = options.loadGraceMs ?? 150;
  const timeoutMs = options.timeoutMs ?? 3000;
  let revealed = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const deadlineTimer = setTimeout(() => revealOnce("timeout"), timeoutMs);

  const cleanup = () => {
    clearTimeout(graceTimer);
    clearTimeout(deadlineTimer);
    win.webContents.removeListener("did-finish-load", onLoad);
    win.removeListener("closed", cleanup);
  };
  const revealOnce = (fallback?: RevealFallback) => {
    if (revealed || win.isDestroyed()) return;
    revealed = true;
    cleanup();
    if (fallback) options.onFallback?.(fallback);
    reveal();
  };
  const onLoad = () => {
    graceTimer = setTimeout(() => revealOnce("did-finish-load"), loadGraceMs);
  };

  win.once("ready-to-show", () => revealOnce());
  if (options.pageLoaded) onLoad();
  else win.webContents.once("did-finish-load", onLoad);
  win.once("closed", cleanup);
}
