/**
 * 单元测试: NuwaClawBridge host 命名空间（宿主产品身份）
 *
 * 锁定契约：
 * 1. 桥上暴露 host.getProduct()，优先采用主进程传入的运行时身份；未传时回退
 *    APP_NAME_IDENTIFIER。nuwax 前端凭此区分社区版与商业版。
 * 2. 即使 preload 后来被社区构建覆盖，商业主进程中的整页导航仍保持商业身份。
 */

import { describe, it, expect, vi } from "vitest";

// vi.mock 工厂会被提升到模块顶部执行，共享 Map 须经 vi.hoisted 创建
const { exposed } = vi.hoisted(() => ({
  exposed: new Map<string, Record<string, unknown>>(),
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn((key: string, api: Record<string, unknown>) => {
      exposed.set(key, api);
    }),
  },
  ipcRenderer: {
    on: vi.fn(),
    send: vi.fn(),
    invoke: vi.fn(),
  },
}));

import "./webviewPerfBridge";
import { APP_NAME_IDENTIFIER } from "@shared/constants";

describe("NuwaClawBridge host 命名空间", () => {
  it("桥上暴露 host.getProduct()，值与 APP_NAME_IDENTIFIER 一致", () => {
    const bridge = exposed.get("NuwaClawBridge") as {
      host?: { getProduct(): string };
    };
    expect(bridge).toBeDefined();
    expect(typeof bridge?.host?.getProduct).toBe("function");
    expect(bridge?.host?.getProduct()).toBe(APP_NAME_IDENTIFIER);
  });

  it("未注入 env 时为社区版缺省身份 nuwaclaw", () => {
    expect(APP_NAME_IDENTIFIER).toBe("nuwaclaw");
  });

  it("运行中的商业主进程身份优先于后来重建的社区 preload", () => {
    const bridge = exposed.get("NuwaClawBridge") as {
      host: { getProduct(): string };
    };
    process.argv.push("--nuwax-host-product=nuwax");
    try {
      expect(APP_NAME_IDENTIFIER).toBe("nuwaclaw");
      expect(bridge.host.getProduct()).toBe("nuwax");
    } finally {
      process.argv.pop();
    }
  });
});
