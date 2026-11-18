import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ENGINE_HOME_DIR_NAME,
  LEGACY_ENGINE_HOME_DIR_NAME,
  engineHomeSegment,
  migrateDirectory,
  resolveEngineHome,
  migrateEngineSegment,
  pruneProjectIsolatedHomeCaches,
} from "./isolatedHomePaths";

vi.mock("electron-log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nuwax-home-migrate-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("engineHomeSegment", () => {
  it("maps the harness ids onto one on-disk segment", () => {
    expect(engineHomeSegment("codex-cli")).toBe("nuwax-harness");
    expect(engineHomeSegment("nuwax-harness")).toBe("nuwax-harness");
    expect(engineHomeSegment("NUWAX-HARNESS")).toBe("nuwax-harness");
  });

  it("leaves unrelated engines untouched", () => {
    expect(engineHomeSegment("nuwaxcode")).toBe("nuwaxcode");
    expect(engineHomeSegment("claude-code")).toBe("claude-code");
  });
});

describe("migrateDirectory", () => {
  it("renames the legacy directory when the target is absent", () => {
    const root = makeTempRoot();
    const legacy = path.join(root, ".codex");
    const target = path.join(root, ".nuwax-harness");
    fs.mkdirSync(path.join(legacy, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "sessions", "rollout.jsonl"), "{}\n");

    expect(migrateDirectory(legacy, target, "test")).toBe(true);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.readFileSync(path.join(target, "sessions", "rollout.jsonl"), "utf8")).toBe(
      "{}\n",
    );
    expect(JSON.parse(fs.readFileSync(path.join(target, ".migration.json"), "utf8"))).toMatchObject(
      { from: ".codex", mode: "rename", label: "test" },
    );
  });

  it("is a no-op when there is nothing to migrate", () => {
    const root = makeTempRoot();
    const target = path.join(root, ".nuwax-harness");
    fs.mkdirSync(target, { recursive: true });
    expect(migrateDirectory(path.join(root, ".codex"), target, "test")).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
  });

  it("merges into an existing target and keeps the legacy directory as a backup", () => {
    const root = makeTempRoot();
    const legacy = path.join(root, ".codex");
    const target = path.join(root, ".nuwax-harness");
    fs.mkdirSync(legacy, { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(legacy, "only-legacy.txt"), "old");
    fs.writeFileSync(path.join(legacy, "conflict.txt"), "old");
    fs.writeFileSync(path.join(target, "conflict.txt"), "new");

    expect(migrateDirectory(legacy, target, "test")).toBe(true);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.readFileSync(path.join(target, "only-legacy.txt"), "utf8")).toBe("old");
    // 冲突时保留 target 的那份
    expect(fs.readFileSync(path.join(target, "conflict.txt"), "utf8")).toBe("new");
    const backups = fs
      .readdirSync(root)
      .filter((name) => name.startsWith(".codex.migrated-"));
    expect(backups).toHaveLength(1);
    // 冲突的那份被改名保留在 target 里（旧内容不丢）
    const conflictBackup = fs
      .readdirSync(target)
      .find((name) => name.startsWith("conflict.txt.from-legacy-"));
    expect(conflictBackup).toBeDefined();
    expect(fs.readFileSync(path.join(target, conflictBackup as string), "utf8")).toBe(
      "old",
    );
  });

  it("keeps the legacy directory when the rename cannot happen", () => {
    const root = makeTempRoot();
    const legacy = path.join(root, ".codex");
    fs.mkdirSync(legacy, { recursive: true });
    // 真实失败：父目录只读，rename 会 EACCES（不 mock，覆盖真实错误分支）
    fs.chmodSync(root, 0o500);
    try {
      expect(
        migrateDirectory(legacy, path.join(root, ".nuwax-harness"), "test"),
      ).toBe(false);
    } finally {
      fs.chmodSync(root, 0o700);
    }
    // 回退：旧目录原样保留，且没有创建空的新目录
    expect(fs.existsSync(legacy)).toBe(true);
    expect(fs.existsSync(path.join(root, ".nuwax-harness"))).toBe(false);
  });
});

describe("resolveEngineHome", () => {
  it("creates the new home for a fresh environment", () => {
    const home = makeTempRoot();
    const resolved = resolveEngineHome(home);
    expect(resolved).toBe(path.join(home, ENGINE_HOME_DIR_NAME));
    expect(fs.statSync(resolved).isDirectory()).toBe(true);
  });

  it("migrates an existing legacy home and keeps its content", () => {
    const home = makeTempRoot();
    const legacy = path.join(home, LEGACY_ENGINE_HOME_DIR_NAME);
    fs.mkdirSync(path.join(legacy, "skills", ".system"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "config.toml"), 'model = "x"\n');
    fs.writeFileSync(path.join(legacy, "installation_id"), "abc\n");

    const resolved = resolveEngineHome(home);
    expect(resolved).toBe(path.join(home, ENGINE_HOME_DIR_NAME));
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.readFileSync(path.join(resolved, "config.toml"), "utf8")).toBe(
      'model = "x"\n',
    );
    expect(
      fs.existsSync(path.join(resolved, "skills", ".system")),
    ).toBe(true);
  });

  it("falls back to the legacy home when migration fails", () => {
    const home = makeTempRoot();
    const legacy = path.join(home, LEGACY_ENGINE_HOME_DIR_NAME);
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "installation_id"), "abc\n");
    fs.chmodSync(home, 0o500);
    const resolved = (() => {
      try {
        return resolveEngineHome(home);
      } finally {
        fs.chmodSync(home, 0o700);
      }
    })();
    expect(resolved).toBe(legacy);
    expect(fs.existsSync(legacy)).toBe(true);
  });
});

describe("migrateEngineSegment", () => {
  it("moves the old codex-cli segment to nuwax-harness", () => {
    const projectRoot = makeTempRoot();
    const legacyHome = path.join(projectRoot, "codex-cli", "home", ".codex");
    fs.mkdirSync(path.join(legacyHome, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(legacyHome, "installation_id"), "abc\n");

    migrateEngineSegment(projectRoot, "codex-cli", "nuwax-harness");

    const migratedHome = path.join(projectRoot, "nuwax-harness", "home", ".codex");
    expect(fs.readFileSync(path.join(migratedHome, "installation_id"), "utf8")).toBe(
      "abc\n",
    );
    expect(fs.existsSync(path.join(projectRoot, "codex-cli"))).toBe(false);
  });

  it("is a no-op for engines that never changed segment", () => {
    const projectRoot = makeTempRoot();
    fs.mkdirSync(path.join(projectRoot, "nuwaxcode", "home"), { recursive: true });
    migrateEngineSegment(projectRoot, "nuwaxcode", "nuwaxcode");
    expect(fs.existsSync(path.join(projectRoot, "nuwaxcode", "home"))).toBe(true);
  });
});

describe("pruneProjectIsolatedHomeCaches migrated backups", () => {
  it("removes expired `.migrated-` backups and keeps fresh ones", () => {
    const root = makeTempRoot();
    const oldBackup = path.join(root, ".codex.migrated-2026-01-01T00-00-00-000Z");
    const freshBackup = path.join(root, ".codex.migrated-2099-01-01T00-00-00-000Z");
    fs.mkdirSync(oldBackup, { recursive: true });
    fs.mkdirSync(freshBackup, { recursive: true });
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldBackup, old, old);

    const pruned = pruneProjectIsolatedHomeCaches(7, {
      migratedMaxAgeDays: 30,
      skipPaths: new Set(),
      root,
    });
    expect(pruned).toBe(1);
    expect(fs.existsSync(oldBackup)).toBe(false);
    expect(fs.existsSync(freshBackup)).toBe(true);
  });
});
