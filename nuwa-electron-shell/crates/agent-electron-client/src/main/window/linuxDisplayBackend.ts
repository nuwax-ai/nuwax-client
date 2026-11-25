/**
 * Linux 上选择窗口系统后端（Chromium 的 ozone platform）。
 *
 * 原生 Wayland 下，Chromium 只能通过合成器的 zwp_text_input_manager_v3 接入输入法，不读 GTK_IM_MODULE。
 * 统信 UOS 20 的 kwin_wayland 没有 v3，原生运行时中文输入法完全不生效；同一台机器上走 XWayland 时，
 * Chromium 改用 GTK 的输入法模块，输入法正常。所以：合成器提供 v3 时保持原生 Wayland；
 * 不提供、且本机有可用的 X 服务时回退到 X11。没有 X 服务可回退时仍然保持原生 Wayland。
 *
 * 决策的结果无法在当前进程里生效：Chromium 在主进程 JS 执行之前就选定了后端，appendSwitch 只会
 * 传给之后创建的子进程。调用方须据此带 --ozone-platform 参数重启（见 main.ts）；
 * 重启后的 argv 已含该参数，这里的"用户已显式指定"分支会让它直接放行，因此只会重启一轮。
 */
import * as fs from "node:fs";
import { hasWaylandGlobalSync, waylandSocketPath } from "./waylandRegistry";

/** Chromium 在原生 Wayland 下默认使用的输入法协议。 */
export const TEXT_INPUT_V3 = "zwp_text_input_manager_v3";

export interface LinuxDisplayDecision {
  /** 需要显式传给 Chromium 的后端；null 表示保持默认。 */
  platform: "x11" | "wayland" | null;
  /** 决定的依据，写进启动日志。 */
  reason: string;
}

export interface LinuxDisplayBackendOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  /** 问合成器是否提供某个接口；返回 null 表示没问到。 */
  query?: (socketPath: string, name: string) => boolean | null;
  exists?: (file: string) => boolean;
}

/** 本机 X 服务的 socket 路径（`DISPLAY=:0` → /tmp/.X11-unix/X0）；带主机名的远程 DISPLAY 不认。 */
export function localXSocketPath(display?: string): string | null {
  const match = /^(?:unix)?:(\d+)(?:\.\d+)?$/.exec(display ?? "");
  return match ? `/tmp/.X11-unix/X${match[1]}` : null;
}

/** 用户已经自己指定了后端（命令行开关，或 Electron 官方的 ELECTRON_OZONE_PLATFORM_HINT）时不再插手。 */
function ozoneRequestedExplicitly(env: NodeJS.ProcessEnv, argv: string[]): boolean {
  if (env.ELECTRON_OZONE_PLATFORM_HINT) return true;
  return argv.slice(1).some((arg) => /^(?:--ozone-platform(?:-hint)?(?:=|$))/.test(arg));
}

export function selectLinuxDisplayBackend(options: LinuxDisplayBackendOptions = {}): LinuxDisplayDecision {
  const {
    platform = process.platform,
    env = process.env,
    argv = process.argv,
    query = (socketPath: string, name: string) => hasWaylandGlobalSync(socketPath, name),
    exists = fs.existsSync,
  } = options;
  if (platform !== "linux") return { platform: null, reason: "" };
  if (ozoneRequestedExplicitly(env, argv)) return { platform: null, reason: "ozone platform was requested explicitly" };
  if (!env.WAYLAND_DISPLAY) return { platform: null, reason: "X11 session" };

  const socketPath = waylandSocketPath(env);
  const xSocket = localXSocketPath(env.DISPLAY);
  if (!socketPath || !xSocket || !exists(xSocket)) {
    return { platform: null, reason: "Wayland kept: no local X server to fall back to" };
  }
  const supports = query(socketPath, TEXT_INPUT_V3);
  if (supports === false) {
    return {
      platform: "x11",
      reason: `Wayland compositor offers no ${TEXT_INPUT_V3}, so a native client would have no input method; using Xwayland`,
    };
  }
  return {
    platform: null,
    reason: supports ? `Wayland compositor offers ${TEXT_INPUT_V3}` : "Wayland compositor could not be queried",
  };
}
