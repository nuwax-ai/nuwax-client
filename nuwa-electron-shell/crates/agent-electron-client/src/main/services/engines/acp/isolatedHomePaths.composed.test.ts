/**
 * 路径组合层测试：`resolveProjectIsolatedHomeDir` / `resolveIsolatedHomePath`
 * 必须把「引擎段」和「home 目录名」两处改名一起处理好，否则会出现
 * “段目录换了、`.codex` 还在”或反之的半迁移状态。
 *
 * 这里把 appData 根指到临时目录，从而能真正跑组合逻辑（而不是只测单函数）。
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ appData: "" }));

vi.mock("../../system/appPaths", () => ({
  getAppDataDir: () => holder.appData,
}));
vi.mock("electron-log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  ENGINE_HOME_DIR_NAME,
  resolveEngineHome,
  resolveIsolatedHomePath,
  resolveProjectIsolatedHomeDir,
} from "./isolatedHomePaths";

let roots: string[] = [];

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nuwax-composed-"));
  roots.push(root);
  holder.appData = root;
});

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

/** 老版本布局：run/projects/6/<dir>/codex-cli/home/.codex/... */
function seedLegacyProject(workDirId: string): string {
  const legacyHome = path.join(
    holder.appData,
    "run",
    "projects",
    "6",
    workDirId,
    "codex-cli",
    "home",
  );
  fs.mkdirSync(path.join(legacyHome, ".codex", "sessions", "2026"), { recursive: true });
  fs.writeFileSync(
    path.join(legacyHome, ".codex", "sessions", "2026", "rollout-old.jsonl"),
    '{"old":true}\n',
  );
  fs.writeFileSync(path.join(legacyHome, ".codex", "installation_id"), "abc\n");
  return legacyHome;
}

describe("resolveProjectIsolatedHomeDir", () => {
  it("returns the nuwax-harness segment and migrates the old codex-cli segment", () => {
    seedLegacyProject("1755386");

    const homeDir = resolveProjectIsolatedHomeDir({
      kind: "project",
      userId: "6",
      workDirId: "1755386",
      engine: "codex-cli",
    });

    expect(homeDir).toBe(
      path.join(holder.appData, "run", "projects", "6", "1755386", "nuwax-harness", "home"),
    );
    // 旧段里的会话跟着搬过来了
    expect(
      fs.readFileSync(
        path.join(homeDir, ".codex", "sessions", "2026", "rollout-old.jsonl"),
        "utf8",
      ),
    ).toBe('{"old":true}\n');
    expect(
      fs.existsSync(path.join(holder.appData, "run", "projects", "6", "1755386", "codex-cli")),
    ).toBe(false);
  });

  it("is stable across repeated resolution (no re-migration churn)", () => {
    seedLegacyProject("42");
    const scope = {
      kind: "project" as const,
      userId: "6",
      workDirId: "42",
      engine: "codex-cli" as const,
    };

    const first = resolveProjectIsolatedHomeDir(scope);
    const second = resolveProjectIsolatedHomeDir(scope);

    expect(second).toBe(first);
    const projectRoot = path.join(holder.appData, "run", "projects", "6", "42");
    expect(fs.readdirSync(projectRoot).filter((n) => n.includes(".migrated-"))).toHaveLength(0);
  });

  it("accepts the product id `nuwax-harness` and lands on the same directory", () => {
    const viaLegacy = resolveProjectIsolatedHomeDir({
      kind: "project",
      userId: "6",
      workDirId: "7",
      engine: "codex-cli",
    });
    const viaProduct = resolveProjectIsolatedHomeDir({
      kind: "project",
      userId: "6",
      workDirId: "7",
      engine: "nuwax-harness",
    });
    expect(viaProduct).toBe(viaLegacy);
  });

  it("keeps non-harness engines on their own segment", () => {
    const homeDir = resolveProjectIsolatedHomeDir({
      kind: "project",
      userId: "6",
      workDirId: "9",
      engine: "nuwaxcode",
    });
    expect(homeDir).toBe(
      path.join(holder.appData, "run", "projects", "6", "9", "nuwaxcode", "home"),
    );
  });
});

describe("resolveIsolatedHomePath (end to end wiring)", () => {
  it("migrates segment + inner home in one call and reports the new paths", () => {
    const legacyHome = seedLegacyProject("1755386");

    const { homeDir, runId } = resolveIsolatedHomePath({
      kind: "project",
      userId: "6",
      workDirId: "1755386",
      engine: "codex-cli",
    });

    expect(runId).toBe("project-1755386-codex-cli");
    expect(homeDir).toBe(
      path.join(holder.appData, "run", "projects", "6", "1755386", "nuwax-harness", "home"),
    );

    // 迁移后的引擎 home 解析：应落到 .nuwax-harness，且旧 .codex 内容仍在
    const engineHome = resolveEngineHome(homeDir);
    expect(engineHome).toBe(path.join(homeDir, ENGINE_HOME_DIR_NAME));
    expect(fs.existsSync(path.join(engineHome, "installation_id"))).toBe(true);
    expect(fs.existsSync(path.join(legacyHome, ".codex"))).toBe(false);
  });
});
