/**
 * Computer Use 特性的宿主接缝（特性内部文件）。
 *
 * 设置库、本地 MCP 条目与随包 Node 运行时都属于宿主；register() 时由 `FeatureContext`
 * 注入，测试注入自己的等价实现。模块级可替换是为了让既有单测的平台覆写 + 模块重载
 * （vi.resetModules）继续成立：重载后的实例由测试重新安装。
 */

import type { FeatureMcpServerEntry } from "../_kit/types";

export interface ComputerUseHostPorts {
  getConversationId?(): string | null;
  /** 特性持久目录（`~/.nuwax/computer-use`）：驱动自有落盘的统一宿主目录。 */
  dataHome: string;
  readSetting(key: string): unknown;
  writeSetting(key: string, value: unknown): boolean;
  /** 登记（entry）或移除（null）本地 MCP 条目并同步 MCP Proxy。 */
  setLocalMcpServer(id: string, entry: FeatureMcpServerEntry | null): Promise<void>;
  hasLocalMcpServer(id: string): boolean;
  /** 随包 Node 运行时路径；不可用时为 null。 */
  resolveNodeBinary(): string | null;
}

const inert: ComputerUseHostPorts = {
  dataHome: "",
  readSetting: () => null,
  writeSetting: () => false,
  setLocalMcpServer: async () => { throw new Error("computerUseHostNotConfigured"); },
  hasLocalMcpServer: () => false,
  resolveNodeBinary: () => null,
};

let ports: ComputerUseHostPorts = inert;

export function configureComputerUseHost(next: ComputerUseHostPorts): void {
  ports = next;
}

export function computerUseHost(): ComputerUseHostPorts {
  return ports;
}
