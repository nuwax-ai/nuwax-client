/**
 * 宿主壳渲染进程自愈。
 *
 * 托盘常驻数周后，壳 renderer 可能因 OOM / GPU 故障崩溃或卡死；此前没有任何
 * 主窗口级处理，用户只能看到空白窗口并从托盘退出重开。这里：
 *  - 崩溃：自动 reload；窗口期内崩溃次数超限则停止自动恢复并交给 onGiveUp，
 *    避免崩溃循环空转；
 *  - 无响应：宽限期内未恢复则强制结束渲染进程，复用崩溃路径重载；
 *  - 应用正在退出 / webContents 已销毁时一律不干预。
 */
import type { WebContents } from "electron";
import log from "electron-log";

export interface RendererRecoveryOptions {
  isQuitting: () => boolean;
  /** 停止自动恢复时调用（只调用一次），由调用方决定如何提示用户 */
  onGiveUp: (reason: string) => void;
  /** 窗口期内允许自动重载的最大崩溃次数，超过即放弃 */
  maxCrashes?: number;
  windowMs?: number;
  unresponsiveGraceMs?: number;
  reloadDelayMs?: number;
  now?: () => number;
}

const DEFAULT_RELOAD_DELAY_MS = 300;
const DEFAULT_MAX_CRASHES = 3;
const DEFAULT_WINDOW_MS = 5 * 60_000;
const DEFAULT_UNRESPONSIVE_GRACE_MS = 60_000;

export function attachRendererRecovery(
  contents: WebContents,
  options: RendererRecoveryOptions,
): void {
  const maxCrashes = options.maxCrashes ?? DEFAULT_MAX_CRASHES;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const graceMs = options.unresponsiveGraceMs ?? DEFAULT_UNRESPONSIVE_GRACE_MS;
  const reloadDelayMs = options.reloadDelayMs ?? DEFAULT_RELOAD_DELAY_MS;
  const now = options.now ?? Date.now;

  const crashes: number[] = [];
  let hangTimer: ReturnType<typeof setTimeout> | null = null;
  let gaveUp = false;

  const inactive = () =>
    gaveUp || options.isQuitting() || contents.isDestroyed();

  const clearHangTimer = () => {
    if (hangTimer === null) return;
    clearTimeout(hangTimer);
    hangTimer = null;
  };

  const giveUp = (reason: string) => {
    if (gaveUp) return;
    gaveUp = true;
    clearHangTimer();
    log.error(`[RendererRecovery] Giving up automatic recovery: ${reason}`);
    options.onGiveUp(reason);
  };

  contents.on("render-process-gone", (_event, details) => {
    clearHangTimer();
    if (details.reason === "clean-exit" || inactive()) return;

    const at = now();
    while (crashes.length > 0 && at - crashes[0] > windowMs) crashes.shift();
    crashes.push(at);
    log.error(
      `[RendererRecovery] Renderer gone: reason=${details.reason} exitCode=${details.exitCode} (${crashes.length}/${maxCrashes} in window)`,
    );

    if (crashes.length > maxCrashes) {
      giveUp(`renderer crashed ${crashes.length} times within ${windowMs}ms (last: ${details.reason})`);
      return;
    }
    // 不可在 render-process-gone 回调内同步 reload：Chromium 仍在拆除旧 RenderFrameHost，
    // 真实 Electron 40 实测会触发 NOTREACHED 并带崩整个主进程。
    setTimeout(() => {
      if (inactive()) return;
      try {
        contents.reload();
      } catch (error) {
        giveUp(`reload failed after ${details.reason}: ${String(error)}`);
      }
    }, reloadDelayMs);
  });

  contents.on("unresponsive", () => {
    if (hangTimer !== null || inactive()) return;
    log.warn(`[RendererRecovery] Renderer unresponsive; forcing restart in ${graceMs}ms if it does not recover`);
    hangTimer = setTimeout(() => {
      hangTimer = null;
      if (inactive()) return;
      log.error("[RendererRecovery] Renderer still unresponsive; forcing restart");
      try {
        contents.forcefullyCrashRenderer();
      } catch (error) {
        giveUp(`forcefullyCrashRenderer failed: ${String(error)}`);
      }
    }, graceMs);
  });

  contents.on("responsive", clearHangTimer);
  contents.once("destroyed", clearHangTimer);
}
