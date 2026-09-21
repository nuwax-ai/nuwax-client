/**
 * 全磁盘访问（macOS Full Disk Access，kTCCServiceSystemPolicyAllFiles）
 * 检测 + 初始化一次性引导。
 *
 * 背景：本客户端的文件链路（file-server 浏览「我的电脑」、引擎读写工作区）由
 * 主进程直系子进程执行，访问受 TCC 保护的目录（~/Desktop、~/Documents、
 * ~/Downloads、~/Library 及其他用户目录等）时按应用身份拦截（EPERM），且裸
 * readdir 不会触发系统授权弹窗——用户无从感知也无从授权。全磁盘访问一次覆盖
 * 全部保护目录，是「我的电脑」全功能链路的正确授权面（对比逐目录授权：文件夹
 * 权限弹窗不会因 readdir 主动出现，链路上没有采集入口）。
 *
 * 检测判据（macOS 26.6 本机实证，见 plans/20260921-full-disk-access.md）：无 FDA
 * 时 open("/Library/Application Support/com.apple.TCC/TCC.db") 抛 Operation not
 * permitted；有 FDA 则成功。主进程与 file-server/引擎子进程同属一个 TCC 身份
 * （安装版=Nuwax.app；dev=node_modules 里的 Electron.app），主进程探测即代表
 * 消费链路——「授权了没生效」多因授错对象（dev 授给 Nuwax / 安装版授给别的），
 * 状态行把真值亮出来正是解法。
 *
 * 引导策略（产品要求 2026-09-21）：初始化（主窗口首帧）检测，未授权且用户未
 * 拒绝过 → 原生弹窗引导一次；点「暂不」→ settings 表持久化记录，此后启动不再
 * 自动弹（设置页状态行是唯一再入口）；点「去开启」不记录——去了没开成，下次
 * 启动仍会提醒一次。窗口聚焦/解锁唤醒只静默刷新状态缓存，绝不弹窗。
 */

import { app, BrowserWindow, dialog, powerMonitor, shell } from "electron";
import { spawn } from "node:child_process";
import log from "electron-log";
import * as path from "node:path";
import { readSetting, writeSetting } from "../db";
import { openMacPrivacySettings } from "./system/macPermissions";
import { t } from "./i18n";

/** settings 表键（值统一 JSON 编码，见 db.readSetting/writeSetting） */
export const FULL_DISK_ACCESS_SETTING_KEY = "nuwax.fullDiskAccessPrompt";

/**
 * 探测目标：系统级 TCC 库。读取它需要 FDA 本身（无授权时 open 即抛
 * EPERM），且各 macOS 版本必然存在——既是判据也是「必然存在」的保证。
 */
const FDA_PROBE_PATH = "/Library/Application Support/com.apple.TCC/TCC.db";

/** 子进程探测脚本：open TCC.db 成功 → exit 0；被拦（EPERM 等）→ exit 2。 */
const FDA_PROBE_SCRIPT =
  'try{const fs=require("fs");const fd=fs.openSync(process.argv[1],"r");fs.closeSync(fd);process.exit(0)}catch(e){process.exit(2)}';

/** 探测超时(ms)。正常 <100ms，给 5s 余量应对系统繁忙。 */
const PROBE_TIMEOUT_MS = 5000;

/** 主窗口首帧兜底超时：ready-to-show 未至（异常窗口形态）时仍完成初始化检测 */
const INIT_PROMPT_FALLBACK_MS = 15000;

/** 聚焦/解锁静默复查的最小间隔（探针只是一次 fs open，防抖只为日志降噪） */
const SILENT_RECHECK_INTERVAL_MS = 3000;

/** 打开系统设置后忽略瞬时焦点抖动；超过此时间再次聚焦视为用户返回客户端 */
const SETTINGS_RETURN_GRACE_MS = 500;

export interface FullDiskAccessStatus {
  /** 当前平台是否存在 FDA 机制（仅 darwin） */
  supported: boolean;
  /** 探测真值；非 darwin 恒 true（无此机制即无拦截） */
  granted: boolean;
  /** 用户是否拒绝过初始化引导（拒绝后不再自动弹窗） */
  dismissed: boolean;
}

// ==================== 运行态 ====================

/** 初始化引导是否已执行过（含「无需弹窗」的判定，每 app 会话至多一次） */
let initPromptDone = false;
let initialized = false;
let lastSilentRecheckAt = 0;
let lastGranted: boolean | null = null;
/** 本会话内见过未授权（用于识别「用户中途完成了授权」的翻转） */
let sawNotGranted = false;
/** 重启提示已弹过（每会话至多一次；启动即已授权的会话永远不弹） */
let restartPromptShown = false;
/** 客户端已打开 FDA 系统设置，等待用户返回客户端 */
let awaitingSettingsReturn = false;
/** 打开 FDA 系统设置后是否真实观察到客户端窗口失焦 */
let settingsRoundTripBlurred = false;
/** 最近一次成功发起打开 FDA 系统设置的时间 */
let settingsOpenedAt = 0;

/** 仅 macOS 有 FDA 机制 */
export function isFullDiskAccessSupported(): boolean {
  return process.platform === "darwin";
}

/**
 * 探测当前应用身份是否具有全磁盘访问。
 *
 * 关键：FDA 是进程启动时的 Seatbelt 配置，**对已运行进程不追溯**（2026-09-21
 * 本机实证：授权后，授权前拉起的 file-server 仍 EPERM）——主进程自己 open
 * TCC.db 测到的只是「上一次启动时」的旧状态，授权翻转在同一进程内探不到。
 * 必须派生新子进程探测「当前授权下新进程」的真实可见性（同
 * workspaceAccessProbe 的子进程复现哲学）。子进程用 process.execPath +
 * ELECTRON_RUN_AS_NODE，与 file-server 完全同一派生形态——TCC 身份=本应用，
 * 正是消费链路的代表。
 *
 * 成功结果不缓存（授权可能被撤销）；探测无法完成（超时/spawn 失败）视为
 * inconclusive 按已授权放行（不误弹引导，设置页状态行仍是人工复查入口）。
 */
export async function checkFullDiskAccess(): Promise<boolean> {
  if (!isFullDiskAccessSupported()) return true;
  return new Promise<boolean>((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, ["-e", FDA_PROBE_SCRIPT, FDA_PROBE_PATH], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch (e) {
      log.warn("[FullDiskAccess] probe spawn failed (inconclusive):", e);
      resolve(true);
      return;
    }
    // settled 守卫：超时/error/close 可能交错，保证只 resolve 一次
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      log.warn(
        `[FullDiskAccess] probe timed out after ${PROBE_TIMEOUT_MS}ms (inconclusive)`,
      );
      resolve(true);
    }, PROBE_TIMEOUT_MS);
    timer.unref?.();
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log.warn(
        `[FullDiskAccess] probe spawn error (inconclusive): ${err.message}`,
      );
      resolve(true);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const granted = code === 0;
      if (granted) {
        if (lastGranted === false) {
          log.info("[FullDiskAccess] granted (child probe passed)");
        }
        lastGranted = true;
        // 本会话曾未授权、现在子进程通过 = 用户刚完成授权——提示重启生效
        if (
          sawNotGranted &&
          !restartPromptShown &&
          !isFullDiskAccessPromptDismissed()
        ) {
          restartPromptShown = true;
          void showRestartDialog().catch((e) =>
            log.error("[FullDiskAccess] restart dialog failed:", e),
          );
        }
      } else {
        if (lastGranted !== false) {
          log.info(
            `[FullDiskAccess] not granted (child probe blocked, exit=${code})`,
          );
        }
        lastGranted = false;
        sawNotGranted = true;
      }
      resolve(granted);
    });
  });
}

/** 解析持久化的拒绝标记（兼容对象形态 { dismissed } 与历史裸布尔） */
export function isFullDiskAccessPromptDismissed(): boolean {
  const raw = readSetting(FULL_DISK_ACCESS_SETTING_KEY);
  if (raw === true) return true;
  return (
    typeof raw === "object" &&
    raw !== null &&
    (raw as { dismissed?: unknown }).dismissed === true
  );
}

/** 用户拒绝引导：持久化，此后启动不再自动弹窗 */
function markPromptDismissed(): void {
  writeSetting(FULL_DISK_ACCESS_SETTING_KEY, { dismissed: true });
  log.info("[FullDiskAccess] prompt dismissed by user (persisted)");
}

/** IPC：状态快照（设置页状态行数据源） */
export async function getFullDiskAccessStatus(): Promise<FullDiskAccessStatus> {
  const granted = await checkFullDiskAccess();
  return {
    supported: isFullDiskAccessSupported(),
    granted,
    dismissed: isFullDiskAccessPromptDismissed(),
  };
}

/**
 * 打开系统设置「完全磁盘访问权限」面板。基座 URL 在新 macOS 上若失效，
 * 兜底打开「隐私与安全性」主面板（用户自行点进子项），不报错。
 */
export async function openFullDiskAccessSettings(): Promise<boolean> {
  // 必须在 openExternal 前置位：系统设置可能在 Promise resolve 前就让客户端失焦。
  awaitingSettingsReturn = true;
  settingsRoundTripBlurred = false;
  settingsOpenedAt = Date.now();
  const ok = await openMacPrivacySettings("file_access");
  if (ok) return true;
  awaitingSettingsReturn = false;
  settingsOpenedAt = 0;
  try {
    awaitingSettingsReturn = true;
    settingsRoundTripBlurred = false;
    settingsOpenedAt = Date.now();
    await shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security",
    );
    return true;
  } catch (e) {
    awaitingSettingsReturn = false;
    settingsOpenedAt = 0;
    log.error("[FullDiskAccess] open settings fallback failed:", e);
    return false;
  }
}

/**
 * 引导弹窗里要用户去开启的应用显示名。系统设置 FDA 列表按运行 bundle 显示：
 * 安装版=Nuwax、dev=node_modules 里的 Electron——而 app.getName() 在 dev 下
 * 返回 crate productName（NuwaClaw），会把用户引向列表里不存在的条目（正是
 * 「授权了没生效」的典型错位），故以 execPath basename 对齐 TCC 真实身份。
 */
function currentAppDisplayName(): string {
  try {
    return path.basename(app.getPath("exe")) || app.getName() || "Nuwax";
  } catch {
    return app.getName() || "Nuwax";
  }
}

/** 原生引导弹窗（同 workspaceAccessProbe 形态）：〔去开启 / 暂不开启〕 */
async function showFullDiskAccessDialog(): Promise<void> {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  const options: Electron.MessageBoxOptions = {
    type: "warning",
    title: t("Claw.FullDiskAccess.title"),
    message: t("Claw.FullDiskAccess.title"),
    detail: t("Claw.FullDiskAccess.detail", currentAppDisplayName()),
    buttons: [
      t("Claw.FullDiskAccess.openSettings"),
      t("Claw.FullDiskAccess.later"),
    ],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const res = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options);
  log.info(
    "[FullDiskAccess] init dialog response=%s",
    res.response === 0 ? "open_settings" : "later",
  );
  if (res.response === 0) {
    // 去开启不记录 dismissed：用户若中途放弃，下次启动仍提醒一次
    await openFullDiskAccessSettings();
  } else {
    markPromptDismissed();
  }
}

/**
 * 初始化检测 + 一次性引导（每 app 会话至多执行一次判定）。
 * 未授权且未拒绝过才弹窗；已授权/已拒绝只走静默路径。
 */
async function runInitPromptOnce(): Promise<void> {
  if (initPromptDone) return;
  initPromptDone = true;
  try {
    const granted = await checkFullDiskAccess();
    if (granted) {
      log.info("[FullDiskAccess] init check: granted");
      return;
    }
    if (isFullDiskAccessPromptDismissed()) {
      log.info("[FullDiskAccess] init check: not granted, prompt dismissed");
      return;
    }
    log.info("[FullDiskAccess] init check: not granted, showing dialog");
    await showFullDiskAccessDialog();
  } catch (e) {
    log.error("[FullDiskAccess] init prompt failed:", e);
  }
}

/** 聚焦/解锁沿的静默复查：只刷新状态缓存，绝不弹窗 */
function silentRecheck(): void {
  const now = Date.now();
  if (now - lastSilentRecheckAt < SILENT_RECHECK_INTERVAL_MS) return;
  lastSilentRecheckAt = now;
  void checkFullDiskAccess().catch(() => undefined);
}

/**
 * macOS 没有官方 FDA 状态查询 API；授权前启动的进程也不能可靠观察到同会话内
 * 的授权翻转。因而「打开设置 → 客户端失焦后返回」，以及原生 modal 已让底层
 * 窗口预先失焦时的「超过切换保护期后再次聚焦」，共同组成重启提示闭环。这里
 * 不宣称已经确认授权；下次启动仍由实际文件访问探针给出真值。
 */
function handleWindowFocus(): void {
  const returnedAfterGrace =
    settingsOpenedAt > 0 &&
    Date.now() - settingsOpenedAt >= SETTINGS_RETURN_GRACE_MS;
  if (
    awaitingSettingsReturn &&
    (settingsRoundTripBlurred || returnedAfterGrace) &&
    sawNotGranted &&
    !restartPromptShown &&
    !isFullDiskAccessPromptDismissed()
  ) {
    awaitingSettingsReturn = false;
    settingsRoundTripBlurred = false;
    settingsOpenedAt = 0;
    restartPromptShown = true;
    log.info(
      "[FullDiskAccess] returned from settings after blocked state; prompting restart",
    );
    void showRestartDialog().catch((e) =>
      log.error("[FullDiskAccess] restart dialog failed:", e),
    );
  }
  silentRecheck();
}

/**
 * boot 钩子（registerAllHandlers 内调用，同 powerPolicy.initPowerPolicy
 * 先例）：本钩子先于 createWindow 执行拿不到窗口实例，挂
 * browser-window-created 等主窗口首帧（ready-to-show）再做检测引导，
 * 15s 兜底保证异常窗口形态下初始化检测仍会执行。重复调用幂等。
 */
export function initFullDiskAccessGuard(): void {
  if (initialized) return;
  if (!isFullDiskAccessSupported()) return;
  initialized = true;

  app.on("browser-window-created", (_event, win) => {
    win.once("ready-to-show", () => void runInitPromptOnce());
    // ready-to-show 未至的兜底（销毁/异常形态）；先到者赢，initPromptDone 幂等
    const timer = setTimeout(
      () => void runInitPromptOnce(),
      INIT_PROMPT_FALLBACK_MS,
    );
    timer.unref?.();
    win.once("closed", () => clearTimeout(timer));
  });
  app.on("browser-window-blur", () => {
    if (awaitingSettingsReturn) settingsRoundTripBlurred = true;
  });
  app.on("browser-window-focus", () => handleWindowFocus());
  powerMonitor.on("unlock-screen", () => silentRecheck());
  powerMonitor.on("resume", () => silentRecheck());
}

/**
 * 授权流程后的重启提示（产品要求：客户端自己引导，不依赖用户记得重启）。
 * TCC 授权对已运行进程不追溯，重启后文件链路才真正放行。
 */
async function showRestartDialog(): Promise<void> {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  const options: Electron.MessageBoxOptions = {
    type: "info",
    title: t("Claw.FullDiskAccess.restartTitle"),
    message: t("Claw.FullDiskAccess.restartTitle"),
    detail: t("Claw.FullDiskAccess.restartDetail"),
    buttons: [
      t("Claw.FullDiskAccess.restartNow"),
      t("Claw.FullDiskAccess.restartLater"),
    ],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const res = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options);
  log.info(
    "[FullDiskAccess] restart dialog response=%s",
    res.response === 0 ? "restart_now" : "restart_later",
  );
  if (res.response !== 0) return;
  // 走 app.quit() 触发 before-quit 清理链（引擎树/服务/CUA daemon）后再退出；
  // app.exit(0) 会跳过 before-quit/will-quit，把子进程全部孤儿化。
  app.relaunch();
  app.quit();
}

/** 仅测试用：复位模块运行态 */
export function _resetFullDiskAccessForTest(): void {
  initPromptDone = false;
  initialized = false;
  lastSilentRecheckAt = 0;
  lastGranted = null;
  sawNotGranted = false;
  restartPromptShown = false;
  awaitingSettingsReturn = false;
  settingsRoundTripBlurred = false;
  settingsOpenedAt = 0;
}
