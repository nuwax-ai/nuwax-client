/**
 * 单元测试: migrate + 品牌注入（overlay 商业版 identifier=nuwax + 端口偏移 1000）
 *
 * overlay 商业语义（2026-09-11 改名 nuwawork→nuwax 决策）：迁移链置空、全新开始。
 * 与基座版测试的差异 = 本文件随 overlay 同步覆写基座 migrate.commercial.test.ts，
 * 断言 overlay 行为而非基座行为：
 * 1. APP_DATA_DIR_NAME 派生为 .nuwax
 * 2. 同机存在 .nuwaclaw 也不迁移（不 rename / 不 copy）——阻断劫持社区版数据
 * 3. 新目录已存在且 DB 为空时也不从旧目录导入
 * 4. 目标已有数据 → 跳过
 * 5. migrateSettingsPaths 重写 step1_config.workspaceDir 的 .nuwaclaw 前缀（保留基座行为）
 * 6. 默认工作空间目录：未配置时创建 ~/Nuwax 并落 step1_config.workspaceDir
 *    （已配置不覆盖；建目录失败不落值）
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import * as path from "path";

// 必须在动态 import constants/migrate 之前设置（构建期 define 的运行时等价物）
process.env.NUWAX_APP_IDENTIFIER = "nuwax";
process.env.NUWAX_PORT_OFFSET = "1000";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/mock/home") },
}));

vi.mock("electron-log", () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const mockExistsSync = vi.fn((_p: string) => false);
const mockRenameSync = vi.fn();
const mockCopyFileSync = vi.fn();
const mockReadFileSync = vi.fn((_p: string) => "{}");
const mockWriteFileSync = vi.fn();
const mockMkdirSync = vi.fn();

vi.mock("fs", () => ({
  existsSync: (p: string) => mockExistsSync(p),
  renameSync: (o: string, n: string) => mockRenameSync(o, n),
  copyFileSync: (o: string, n: string) => mockCopyFileSync(o, n),
  readFileSync: (p: string) => mockReadFileSync(p),
  writeFileSync: (p: string, data: string) => mockWriteFileSync(p, data),
  mkdirSync: (p: string, opts?: unknown) => mockMkdirSync(p, opts),
}));

const mockReadSetting = vi.fn((..._args: unknown[]): unknown => null);
const mockWriteSetting = vi.fn();

vi.mock("../db", () => ({
  readSetting: (...args: unknown[]) => mockReadSetting(...args),
  writeSetting: (...args: unknown[]) => mockWriteSetting(...args),
}));

const mockDbPrepare = vi.fn();
const mockDbClose = vi.fn();

vi.mock("better-sqlite3", () => ({
  default: vi.fn(() => ({
    prepare: mockDbPrepare,
    close: mockDbClose,
  })),
}));

afterAll(() => {
  delete process.env.NUWAX_APP_IDENTIFIER;
  delete process.env.NUWAX_PORT_OFFSET;
});

describe("commercial branding (overlay, identifier=nuwax)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbPrepare.mockReturnValue({ get: () => ({ count: 0 }) });
  });

  it.each([".nuwaclaw", ".nuwawork", ".nuwax-agent", ".nuwaxbot"])(
    "never probes or imports legacy product %s",
    async (legacy) => {
      mockExistsSync.mockImplementation((p: string) => p.includes(legacy));
      const { migrateDataDir } = await import("./migrate");
      migrateDataDir();
      expect(
        mockExistsSync.mock.calls.some(([p]) => String(p).includes(legacy)),
      ).toBe(false);
      expect(mockRenameSync).not.toHaveBeenCalled();
      expect(mockCopyFileSync).not.toHaveBeenCalled();
    },
  );

  it("derives APP_DATA_DIR_NAME from injected identifier", async () => {
    const { APP_DATA_DIR_NAME } = await import("@shared/constants");
    expect(APP_DATA_DIR_NAME).toBe(".nuwax");
  });

  it("does NOT rename .nuwaclaw when target .nuwax missing (fresh start)", async () => {
    const legacyDir = path.join("/mock/home", ".nuwaclaw");
    mockExistsSync.mockImplementation((p: string) => p === legacyDir);

    const { migrateDataDir } = await import("./migrate");
    migrateDataDir();

    expect(mockRenameSync).not.toHaveBeenCalled();
    expect(mockCopyFileSync).not.toHaveBeenCalled();
  });

  it("does NOT import legacy db when new dir exists but db empty", async () => {
    const legacyDb = path.join("/mock/home", ".nuwaclaw", "nuwaclaw.db");
    const newDir = path.join("/mock/home", ".nuwax");
    mockExistsSync.mockImplementation((p: string) => {
      if (p === newDir) return true;
      if (p === legacyDb) return true;
      return false;
    });

    const { migrateDataDir } = await import("./migrate");
    migrateDataDir();

    expect(mockCopyFileSync).not.toHaveBeenCalled();
    expect(mockRenameSync).not.toHaveBeenCalled();
  });

  it("skips migration when target .nuwax already has data", async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.includes(".nuwax")) return true;
      return false;
    });
    mockDbPrepare.mockReturnValue({ get: () => ({ count: 5 }) });

    const { migrateDataDir } = await import("./migrate");
    migrateDataDir();

    expect(mockRenameSync).not.toHaveBeenCalled();
    expect(mockCopyFileSync).not.toHaveBeenCalled();
  });

  it("rewrites step1_config.workspaceDir legacy prefix to .nuwax", async () => {
    mockReadSetting.mockReturnValue({
      workspaceDir: path.join("/mock/home", ".nuwaclaw", "workspace"),
    });

    const { migrateSettingsPaths } = await import("./migrate");
    migrateSettingsPaths();

    expect(mockWriteSetting).toHaveBeenCalledWith("step1_config", {
      workspaceDir: path.join("/mock/home", ".nuwax", "workspace"),
    });
  });

  it("creates ~/Nuwax as default workspace dir when unset (fresh install)", async () => {
    mockReadSetting.mockReturnValue(null);

    const { migrateSettingsPaths } = await import("./migrate");
    migrateSettingsPaths();

    expect(mockMkdirSync).toHaveBeenCalledWith(
      path.join("/mock/home", "Nuwax"),
      { recursive: true },
    );
    expect(mockWriteSetting).toHaveBeenCalledWith("step1_config", {
      workspaceDir: path.join("/mock/home", "Nuwax"),
    });
  });

  it("keeps user-configured workspaceDir (no default mkdir/overwrite)", async () => {
    mockReadSetting.mockReturnValue({
      workspaceDir: "/Users/x/my-projects",
      serverHost: "https://testagent.xspaceagi.com",
    });

    const { migrateSettingsPaths } = await import("./migrate");
    migrateSettingsPaths();

    expect(mockMkdirSync).not.toHaveBeenCalled();
    expect(mockWriteSetting).not.toHaveBeenCalled();
  });

  it("does not persist default when workspace dir creation fails", async () => {
    mockReadSetting.mockReturnValue({ serverHost: "https://t.example" });
    mockMkdirSync.mockImplementationOnce(() => {
      throw new Error("EACCES");
    });

    const { migrateSettingsPaths } = await import("./migrate");
    expect(() => migrateSettingsPaths()).not.toThrow();

    expect(mockWriteSetting).not.toHaveBeenCalled();
  });

  it("disables legacy guiMcpEnabled=true (experimental feature removed)", async () => {
    mockReadSetting.mockReturnValue({ guiMcpEnabled: true });

    const { migrateSettingsPaths } = await import("./migrate");
    migrateSettingsPaths();

    expect(mockWriteSetting).toHaveBeenCalledWith("step1_config", {
      guiMcpEnabled: false,
    });
  });

  it("disables legacy sandbox_policy and preserves other fields", async () => {
    mockReadSetting.mockImplementation((key: unknown) =>
      key === "sandbox_policy"
        ? { enabled: true, backend: "auto", mode: "strict" }
        : null,
    );

    const { migrateSettingsPaths } = await import("./migrate");
    migrateSettingsPaths();

    expect(mockWriteSetting).toHaveBeenCalledWith("sandbox_policy", {
      enabled: false,
      backend: "auto",
      mode: "strict",
    });
  });

  it("does not write when experimental flags already off/absent", async () => {
    // workspaceDir 已配置：排除默认工作空间目录落值的干扰，本用例只测 flags 静默
    mockReadSetting.mockReturnValue({
      guiMcpEnabled: false,
      workspaceDir: "/Users/x/wsp",
    });

    const { migrateSettingsPaths } = await import("./migrate");
    migrateSettingsPaths();

    expect(mockWriteSetting).not.toHaveBeenCalled();
  });
});
