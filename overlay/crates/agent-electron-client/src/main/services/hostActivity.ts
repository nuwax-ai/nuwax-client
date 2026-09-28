/**
 * 宿主活跃状态桥（「休眠控制」）
 *
 * 客户端不可见（窗口最小化 / 隐藏到托盘 / 系统锁屏）时，webview 里的 nuwax PC web
 * 感知不到宿主状态，全局事件等轮询照常打后端。本服务收敛宿主可见性事实源，
 * 沿变化沿把 { type: "host-activity", visible } 直发业务文档
 * （复用 guest preload 的 nuwax:host-command 通道），由前端
 * hostBridgeEvents 分发后暂停/恢复轮询，恢复可见立即补拉。
 *
 * 设置项「休眠控制」（settings 表键 nuwax.dormancy，值 { enabled }，默认开）：
 * 关闭后不再下发 invisible 沿，前端保持默认 visible，轮询行为回到基线。
 * 设置写入成功后强制刷新所有窗口；状态迁移与文档同步也读取当前设置。
 *
 * 主窗口 guest 与受信二级业务窗口分别登记；各窗口独立计算可见性，
 * 系统锁屏状态共享。二级窗口只接收活动状态，不参与主窗口菜单动作广播。
 */

import { BrowserWindow, powerMonitor, type WebContents } from "electron";
import log from "electron-log";
import { readSetting } from "../db";

/** guest preload 现有的宿主命令通道，此处复用不新增 preload 面 */
const HOST_COMMAND_CHANNEL = "nuwax:host-command";
const SHELL_ACTIVITY_CHANNEL = "nuwax:host-activity-changed";

/** 设置表键（settings 表统一 JSON 编码存储，见 settingsHandlers） */
export const DORMANCY_SETTING_KEY = "nuwax.dormancy";

export interface HostActivityState {
  windowVisible: boolean;
  locked: boolean;
}

/** 宿主可见 = 窗口未最小化未隐藏 且 未锁屏；失焦不算不可见（并排窗口仍在看） */
export function computeHostVisible(state: HostActivityState): boolean {
  return state.windowVisible && !state.locked;
}

/** 设置值解析：缺省/形态异常一律按默认开，防读库失败把暂停逻辑卡死在关闭态 */
export function isDormancyEnabled(settingValue: unknown): boolean {
  if (
    typeof settingValue === "object" &&
    settingValue !== null &&
    "enabled" in settingValue
  ) {
    const enabled = (settingValue as { enabled: unknown }).enabled;
    if (typeof enabled === "boolean") {
      return enabled;
    }
  }
  return true;
}

/** visible 沿总是下发（让前端回到活跃是安全的）；invisible 沿受休眠开关门控 */
export function shouldPushHostActivity(
  visible: boolean,
  dormancyEnabled: boolean,
): boolean {
  return visible || dormancyEnabled;
}

// ==================== 运行态 ====================

const guests = new Set<WebContents>();
const guestCleanups = new Map<WebContents, () => void>();
interface BusinessWindowActivity {
  windowVisible: boolean;
  lastPushedVisible: boolean | null;
  cleanup: () => void;
}
const businessWindows = new Map<WebContents, BusinessWindowActivity>();
let mainWindowContents: WebContents | null = null;
let state: HostActivityState = { windowVisible: true, locked: false };
let lastPushedVisible: boolean | null = null;

/** UI 查询只读快照：关闭休眠时保持既有全量轮询语义。 */
export function getHostActivitySnapshot(): { visible: boolean } {
  return {
    visible: computeHostVisible(state) || !isDormancyEnabled(readSetting(DORMANCY_SETTING_KEY)),
  };
}

function detachGuest(guest: WebContents): void {
  guestCleanups.get(guest)?.();
  guestCleanups.delete(guest);
  guests.delete(guest);
}

function emitToShell(visible: boolean): void {
  if (mainWindowContents && !mainWindowContents.isDestroyed()) {
    mainWindowContents.send(SHELL_ACTIVITY_CHANNEL, { visible });
  }
}

/** 仅同步已登记的业务文档，二级窗口使用自身快照。 */
export function syncHostActivityGuest(guest: WebContents): void {
  if (guests.has(guest)) emitToGuests(getHostActivitySnapshot().visible, guest);
  else emitToBusinessWindow(guest, true);
}

function emitToBusinessWindow(contents: WebContents, force = false): void {
  const activity = businessWindows.get(contents);
  if (!activity) return;
  if (contents.isDestroyed()) {
    activity.cleanup();
    return;
  }
  const visible = computeHostVisible({ windowVisible: activity.windowVisible, locked: state.locked }) ||
    !isDormancyEnabled(readSetting(DORMANCY_SETTING_KEY));
  if (!force && visible === activity.lastPushedVisible) return;
  activity.lastPushedVisible = visible;
  contents.send(HOST_COMMAND_CHANNEL, { type: "host-activity", visible });
}

function recomputeAllWindows(reason: string, force = false): void {
  recompute(reason, force);
  for (const contents of [...businessWindows.keys()]) emitToBusinessWindow(contents, force);
}

/** 设置提交后立即重推各窗口事实；关闭休眠让已暂停的隐藏文档恢复活跃。 */
export function refreshHostActivity(): void {
  recomputeAllWindows("dormancy-setting", true);
}

function emitToGuests(visible: boolean, only?: WebContents): void {
  const targets = only ? [only] : [...guests];
  for (const guest of targets) {
    if (guest.isDestroyed()) {
      detachGuest(guest);
      continue;
    }
    guest.send(HOST_COMMAND_CHANNEL, { type: "host-activity", visible });
  }
}

/**
 * 向主窗口全部 webview guest 下发宿主命令（新建任务/打开搜索等应用菜单动作）。
 * guests 集合由 attachHostActivityWindow 经 did-attach-webview 登记，只含主窗口
 * 的 guest——菜单动作语义即"作用于主界面"，二级窗口的 guest 不在此列。
 */
export function sendHostCommandToMainWindowGuests(payload: unknown): void {
  for (const guest of [...guests]) {
    if (guest.isDestroyed()) {
      detachGuest(guest);
      continue;
    }
    guest.send(HOST_COMMAND_CHANNEL, payload);
  }
}

function recompute(reason: string, force = false): void {
  const visible = force ? getHostActivitySnapshot().visible : computeHostVisible(state);
  if (!force && visible === lastPushedVisible) {
    return;
  }
  const dormancyEnabled = isDormancyEnabled(readSetting(DORMANCY_SETTING_KEY));
  if (!shouldPushHostActivity(visible, dormancyEnabled)) {
    return;
  }
  lastPushedVisible = visible;
  log.info(
    "[HostActivity] %s -> visible=%s (guests=%d)",
    reason,
    visible,
    guests.size,
  );
  emitToGuests(visible);
  emitToShell(visible);
}

/**
 * 新 guest 初始同步：覆盖 --hidden 冷启动 / 隐藏期间 webview 重载——
 * 这些场景没有后续状态沿可等。可见是前端默认态，只有不可见才需要下发。
 */
function attachGuest(contents: WebContents): void {
  if (guests.has(contents)) return;
  guests.add(contents);
  const syncLoadedDocument = () => syncHostActivityGuest(contents);
  const destroyed = () => detachGuest(contents);
  // 重载复用同一 WebContents，新文档不会再次触发 did-attach-webview。
  contents.on("did-finish-load", syncLoadedDocument);
  contents.once("destroyed", destroyed);
  guestCleanups.set(contents, () => {
    contents.removeListener("did-finish-load", syncLoadedDocument);
    contents.removeListener("destroyed", destroyed);
  });
  if (
    !computeHostVisible(state) &&
    isDormancyEnabled(readSetting(DORMANCY_SETTING_KEY))
  ) {
    log.info(
      "[HostActivity] guest attached while hidden, syncing visible=false",
    );
    emitToGuests(false, contents);
  }
}

/**
 * 挂接主窗口：窗口可见性事件 + webview guest 登记。
 * 在 createWindow() 内窗口创建后调用；窗口销毁时自动清理（closed 沿）。
 */
export function attachHostActivityWindow(win: BrowserWindow): void {
  state = { ...state, windowVisible: win.isVisible() };
  mainWindowContents = win.webContents;
  const syncShellDocument = () => emitToShell(getHostActivitySnapshot().visible);
  win.webContents.on("did-finish-load", syncShellDocument);
  const setWindowVisible = (windowVisible: boolean, reason: string): void => {
    state = { ...state, windowVisible };
    recompute(reason);
  };
  win.on("minimize", () => setWindowVisible(false, "minimize"));
  win.on("restore", () => setWindowVisible(true, "restore"));
  win.on("show", () => setWindowVisible(true, "show"));
  // close 被拦截为 hide()（托盘模式），hide 沿即托盘隐藏
  win.on("hide", () => setWindowVisible(false, "hide"));
  win.webContents.on("did-attach-webview", (_event, contents) => {
    attachGuest(contents);
  });
  win.on("closed", () => {
    for (const guest of [...guests]) detachGuest(guest);
    win.webContents.removeListener("did-finish-load", syncShellDocument);
    if (mainWindowContents === win.webContents) mainWindowContents = null;
    state = { ...state, windowVisible: true };
    lastPushedVisible = null;
  });
}

/**
 * 受信二级业务窗口直接承载 PC web，独立跟随自身可见性。
 * 创建方须完成业务域分类后、loadURL 前调用；外链窗口不登记。
 */
export function attachHostActivityBusinessWindow(win: BrowserWindow): void {
  const contents = win.webContents;
  if (businessWindows.has(contents) || contents.isDestroyed()) return;
  const activity: BusinessWindowActivity = {
    windowVisible: win.isVisible(),
    lastPushedVisible: null,
    cleanup: () => {},
  };
  const setVisible = (visible: boolean) => {
    if (!businessWindows.has(contents)) return;
    activity.windowVisible = visible;
    emitToBusinessWindow(contents);
  };
  const syncDocument = () => syncHostActivityGuest(contents);
  const hidden = () => setVisible(false);
  const shown = () => setVisible(true);
  const cleanup = () => {
    businessWindows.delete(contents);
    win.removeListener("hide", hidden);
    win.removeListener("minimize", hidden);
    win.removeListener("show", shown);
    win.removeListener("restore", shown);
    win.removeListener("closed", cleanup);
    contents.removeListener("did-finish-load", syncDocument);
    contents.removeListener("destroyed", cleanup);
  };
  activity.cleanup = cleanup;
  businessWindows.set(contents, activity);
  win.on("hide", hidden);
  win.on("minimize", hidden);
  win.on("show", shown);
  win.on("restore", shown);
  win.on("closed", cleanup);
  contents.on("did-finish-load", syncDocument);
  contents.once("destroyed", cleanup);
  if (!computeHostVisible({ windowVisible: activity.windowVisible, locked: state.locked }) &&
    isDormancyEnabled(readSetting(DORMANCY_SETTING_KEY))) emitToBusinessWindow(contents);
}

/**
 * 注册系统级电源事件（app ready 后调用一次）。
 * suspend 期间 Node 定时器不走，无需处理；resume 后强制重推当前态，
 * 治愈 guest 重载 / 事件丢失造成的漂移（lock 态由 lock-screen/unlock-screen 维护，
 * 唤醒后若仍处锁屏，unlock-screen 迟早会来，期间保持 invisible 是安全侧）。
 *
 * 已知边界：应用在「已锁屏」状态下启动（如 SSH/远程拉起）收不到 lock-screen
 * 沿（Electron 无锁屏状态查询 API，实测 WebContents.visibilityState 为
 * undefined、isVisible 恒 true），轮询会跑到用户首次解锁为止；开机自启实际
 * 在用户登录后启动不受影响。2026-09-17 锁屏态实测确认。
 */
let powerEventsBound = false;

export function initHostActivity(): void {
  if (powerEventsBound) {
    return;
  }
  powerEventsBound = true;
  powerMonitor.on("lock-screen", () => {
    state = { ...state, locked: true };
    recomputeAllWindows("lock-screen");
  });
  powerMonitor.on("unlock-screen", () => {
    state = { ...state, locked: false };
    recomputeAllWindows("unlock-screen");
  });
  powerMonitor.on("suspend", () => recomputeAllWindows("suspend"));
  powerMonitor.on("resume", () => recomputeAllWindows("resume", true));
}

/** 仅测试用：复位模块运行态 */
export function _resetHostActivityForTest(): void {
  for (const guest of [...guests]) detachGuest(guest);
  for (const activity of [...businessWindows.values()]) activity.cleanup();
  mainWindowContents = null;
  state = { windowVisible: true, locked: false };
  lastPushedVisible = null;
  powerEventsBound = false;
}
