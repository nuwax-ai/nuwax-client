/**
 * 单元测试: 引擎强制覆盖（DevToolsPanel 测试开关背后的逻辑）
 *
 * 覆盖 isEngineOverrideAllowed 的三种放行组合，以及
 * applyForcedEngineToRequest 对 stable 的拦截（设置里有值也不接管）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const settings = new Map<string, unknown>();
const readSetting = vi.fn((key: string) => (settings.has(key) ? settings.get(key) : null));

vi.mock("electron-log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../db", () => ({ readSetting: (key: string) => readSetting(key) }));

import {
  applyForcedEngineToRequest,
  isEngineOverrideAllowed,
  DEV_FORCE_ENGINE_HARNESS,
  DEV_FORCE_ENGINE_SETTING_KEY,
} from "./engineOverride";

describe("isEngineOverrideAllowed", () => {
  it("开发构建放行", () => {
    expect(
      isEngineOverrideAllowed({ nodeEnv: "development", updateChannel: null }),
    ).toBe(true);
  });

  it("beta 通道包放行（打包构建 NODE_ENV 为 production，靠通道放行）", () => {
    expect(
      isEngineOverrideAllowed({ nodeEnv: "production", updateChannel: "beta" }),
    ).toBe(true);
  });

  it("stable 一律不放行，即使设置里留着值", () => {
    // 用户在 beta 下开启后切到 stable：设置仍在，但不得接管 agent 启动
    expect(
      isEngineOverrideAllowed({ nodeEnv: "production", updateChannel: "stable" }),
    ).toBe(false);
    expect(
      isEngineOverrideAllowed({ nodeEnv: "production", updateChannel: null }),
    ).toBe(false);
  });

  it("stable 通道下的本地开发构建仍放行（开发优先）", () => {
    expect(
      isEngineOverrideAllowed({ nodeEnv: "development", updateChannel: "stable" }),
    ).toBe(true);
  });
});

describe("applyForcedEngineToRequest", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalForce = process.env.NUWACLAW_FORCE_ENGINE;

  beforeEach(() => {
    settings.clear();
    delete process.env.NUWACLAW_FORCE_ENGINE;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalForce === undefined) delete process.env.NUWACLAW_FORCE_ENGINE;
    else process.env.NUWACLAW_FORCE_ENGINE = originalForce;
  });

  it("stable 打包版即使设置里有值也不改写请求", () => {
    process.env.NODE_ENV = "production";
    settings.set(DEV_FORCE_ENGINE_SETTING_KEY, DEV_FORCE_ENGINE_HARNESS);
    settings.set("update_channel", "stable");
    const request: { agent_config?: { agent_server?: { command?: string } } | null } = {
      agent_config: { agent_server: { command: "claude-code-acp-ts" } },
    };
    expect(applyForcedEngineToRequest(request)).toBeNull();
    expect(request.agent_config?.agent_server?.command).toBe("claude-code-acp-ts");
  });

  it("beta 打包版改写请求并返回强制命令", () => {
    process.env.NODE_ENV = "production";
    settings.set(DEV_FORCE_ENGINE_SETTING_KEY, DEV_FORCE_ENGINE_HARNESS);
    settings.set("update_channel", "beta");
    const request: { agent_config?: { agent_server?: { command?: string } } | null } = {
      agent_config: { agent_server: { command: "claude-code-acp-ts" } },
    };
    expect(applyForcedEngineToRequest(request)).toBe(DEV_FORCE_ENGINE_HARNESS);
    expect(request.agent_config?.agent_server?.command).toBe(DEV_FORCE_ENGINE_HARNESS);
  });

  it("开发构建下 env 优先于设置值", () => {
    process.env.NODE_ENV = "development";
    settings.set(DEV_FORCE_ENGINE_SETTING_KEY, "from-setting");
    process.env.NUWACLAW_FORCE_ENGINE = "from-env";
    const request: { agent_config?: { agent_server?: { command?: string } } | null } = {};
    expect(applyForcedEngineToRequest(request)).toBe("from-env");
    expect(request.agent_config?.agent_server?.command).toBe("from-env");
  });

  it("没有设置值时保持请求不变", () => {
    process.env.NODE_ENV = "development";
    const request: { agent_config?: { agent_server?: { command?: string } } | null } = {
      agent_config: { agent_server: { command: "claude-code-acp-ts" } },
    };
    expect(applyForcedEngineToRequest(request)).toBeNull();
    expect(request.agent_config?.agent_server?.command).toBe("claude-code-acp-ts");
  });
});
