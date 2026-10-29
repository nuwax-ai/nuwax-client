/**
 * 电源策略服务（「允许锁屏运行」）
 *
 * 用户可选锁屏/熄屏后的运行方式：关闭 / 熄屏后保持唤醒 / 保持屏幕常亮。
 * 非关闭档持有 Electron powerSaveBlocker 断言，阻止系统空闲睡眠（keepAwake）
 * 或连屏幕熄灭一起阻止（keepDisplayOn），保障 Computer Use 远程控制与后台
 * Agent 任务在人离开后持续执行。
 *
 * 平台底层映射（Electron 语义）：
 * - prevent-app-suspension = macOS IOKit NoIdleSleep ≈ caffeinate -i；
 *   Windows SetThreadExecutionState(ES_SYSTEM_REQUIRED)
 * - prevent-display-sleep  = macOS IOKit NoDisplaySleep ≈ caffeinate -d；
 *   Windows SetThreadExecutionState(ES_DISPLAY_REQUIRED)
 *
 * 已知边界（powerSaveBlocker 只管「睡眠/熄屏」，管不了「锁屏」）：
 * - 用户手动锁屏不产生睡眠，断言既不阻止也不解除——macOS 锁屏会话阻塞 AX
 *   注入（见 hostActivity.ts 实测注释），Windows 锁屏/RDP 断连后截图取缓存
 *   旧帧，远程控制在锁屏下均受限；
 * - 「保持屏幕常亮」的作用链是防熄屏 → 防超时自动锁屏 → 会话保持可用；
 * - macOS 合盖（clamshell）维持唤醒需外接电源+外显，断言不改变该行为。
 *
 * 断言生命周期 = 进程生命周期（退出由 OS 自动回收），无需 quit 清理。
 * 设置项（settings 表键 nuwax.powerPolicy，值 { mode }，默认 off——保活是
 * 耗电行为，缺省/形态异常一律回退关闭的安全侧）。UI 经 powerPolicy:get /
 * powerPolicy:setMode 即点即存，主进程写库并即时应用；boot 时读库恢复。
 *
 * 扩展预留：当前单断言常驻持有；v2 若做「任务门控」（cua 会话/下载活跃才
 * 保活），把 applyMode 的单 id 换成引用计数 acquire/release，档位语义不变。
 */

import { powerSaveBlocker } from "electron";
import log from "electron-log";
import { readSetting, writeSetting } from "../db";

/** settings 表键（值统一 JSON 编码，见 db.readSetting/writeSetting） */
export const POWER_POLICY_SETTING_KEY = "nuwax.powerPolicy";

export type PowerPolicyMode = "off" | "keepAwake" | "keepDisplayOn";

const MODES: readonly PowerPolicyMode[] = [
  "off",
  "keepAwake",
  "keepDisplayOn",
];

/**
 * 档位解析：接受裸字符串或存储形态 { mode }；缺省/形态异常一律按 off
 * （保活是耗电行为，安全侧回关闭）。
 */
export function normalizePowerPolicyMode(raw: unknown): PowerPolicyMode {
  const value =
    typeof raw === "object" && raw !== null && "mode" in raw
      ? (raw as { mode: unknown }).mode
      : raw;
  return MODES.includes(value as PowerPolicyMode)
    ? (value as PowerPolicyMode)
    : "off";
}

// ==================== 运行态 ====================

let blockerId: number | null = null;
let appliedMode: PowerPolicyMode = "off";
let initialized = false;

function releaseBlocker(): void {
  if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) {
    powerSaveBlocker.stop(blockerId);
  }
  blockerId = null;
}

/** 应用档位：同档幂等；换档先释放旧断言再按需持有新断言 */
function applyMode(mode: PowerPolicyMode): void {
  if (mode === appliedMode) {
    return;
  }
  releaseBlocker();
  if (mode !== "off") {
    blockerId = powerSaveBlocker.start(
      mode === "keepAwake" ? "prevent-app-suspension" : "prevent-display-sleep",
    );
  }
  appliedMode = mode;
  log.info("[PowerPolicy] applied mode=%s (blocker=%s)", mode, blockerId);
}

export function getPowerPolicyMode(): PowerPolicyMode {
  return normalizePowerPolicyMode(readSetting(POWER_POLICY_SETTING_KEY));
}

/** 设置并即时应用档位；非法值抛错不写库（IPC 层直接回错误给渲染层） */
export function setPowerPolicyMode(mode: unknown): { mode: PowerPolicyMode } {
  const next = normalizePowerPolicyMode(mode);
  if (next !== mode) {
    throw new Error(`invalid power policy mode: ${String(mode)}`);
  }
  writeSetting(POWER_POLICY_SETTING_KEY, { mode: next });
  applyMode(next);
  return { mode: next };
}

/** app ready 后调用一次：读库恢复上次档位（重复调用幂等） */
export function initPowerPolicy(): void {
  if (initialized) {
    return;
  }
  initialized = true;
  applyMode(getPowerPolicyMode());
}

/** 仅测试用：复位模块运行态 */
export function _resetPowerPolicyForTest(): void {
  blockerId = null;
  appliedMode = "off";
  initialized = false;
}
