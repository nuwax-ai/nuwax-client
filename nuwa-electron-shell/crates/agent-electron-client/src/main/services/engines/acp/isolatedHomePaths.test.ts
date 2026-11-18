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
  pruneStaleProjectIsolatedHomes,
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

/** 递归恢复写权限：只读目录留在临时树里会让 rmSync 报 ENOTEMPTY。 */
function restorePerms(dir: string): void {
  try {
    fs.chmodSync(dir, 0o700);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) restorePerms(path.join(dir, entry.name));
    }
  } catch {
    /* 目录可能已迁移/删除，忽略 */
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      restorePerms(root);
      fs.rmSync(root, { recursive: true, force: true });
    }
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

describe("migrateDirectory recursive merge", () => {
  it("merges same-named directories instead of renaming them aside", () => {
    const root = makeTempRoot();
    const legacy = path.join(root, ".codex");
    const target = path.join(root, ".nuwax-harness");
    // 新目录里已有一条会话，旧目录里有另一条；两边都有 sessions/
    fs.mkdirSync(path.join(target, "sessions", "2026", "11"), { recursive: true });
    fs.writeFileSync(path.join(target, "sessions", "2026", "11", "new.jsonl"), "new");
    fs.mkdirSync(path.join(legacy, "sessions", "2026", "10"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "sessions", "2026", "10", "old.jsonl"), "old");

    expect(migrateDirectory(legacy, target, "test")).toBe(true);

    // 两边的会话都在新目录里，且没有 sessions.from-legacy-* 这种旁路目录
    expect(
      fs.readFileSync(path.join(target, "sessions", "2026", "11", "new.jsonl"), "utf8"),
    ).toBe("new");
    expect(
      fs.readFileSync(path.join(target, "sessions", "2026", "10", "old.jsonl"), "utf8"),
    ).toBe("old");
    expect(
      fs.readdirSync(target).filter((name) => name.startsWith("sessions.from-legacy-")),
    ).toHaveLength(0);
  });

  it("keeps going when one entry cannot be moved, and retains the legacy copy", () => {
    const root = makeTempRoot();
    const legacy = path.join(root, ".codex");
    const target = path.join(root, ".nuwax-harness");
    fs.mkdirSync(path.join(legacy, "ok"), { recursive: true });
    fs.mkdirSync(path.join(legacy, "locked"), { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(legacy, "ok", "a.txt"), "a");
    fs.writeFileSync(path.join(legacy, "locked", "b.txt"), "b");

    // 真实失败：只读目录里的条目无法 rename 出去（不 mock fs）
    const lockedDir = path.join(legacy, "locked");
    fs.chmodSync(lockedDir, 0o500);
    try {
      expect(migrateDirectory(legacy, target, "test")).toBe(true);
    } finally {
      restorePerms(root);
    }

    // 能搬的搬走了，搬不动的留在备份里——两头都有，数据不丢
    expect(fs.readFileSync(path.join(target, "ok", "a.txt"), "utf8")).toBe("a");
    const backups = fs.readdirSync(root).filter((name) => name.includes(".migrated-"));
    expect(backups).toHaveLength(1);
    expect(
      fs.readFileSync(path.join(root, backups[0], "locked", "b.txt"), "utf8"),
    ).toBe("b");
  });
});

describe("pruneStaleProjectIsolatedHomes", () => {
  it("prunes stale engine homes but leaves migration backups to their own TTL", () => {
    const root = makeTempRoot();
    const staleHome = path.join(root, "6", "1", "nuwax-harness", "home");
    const backupHome = path.join(root, "6", "1", "codex-cli.migrated-2026-01-01T00-00-00-000Z", "home");
    fs.mkdirSync(staleHome, { recursive: true });
    fs.mkdirSync(backupHome, { recursive: true });
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    fs.utimesSync(staleHome, old, old);
    fs.utimesSync(backupHome, old, old);

    const pruned = pruneStaleProjectIsolatedHomes(7, { root, skipPaths: new Set() });

    expect(pruned).toBe(1);
    expect(fs.existsSync(staleHome)).toBe(false);
    // 备份仍由 30 天 TTL 管理，这里不能删
    expect(fs.existsSync(backupHome)).toBe(true);
  });
});

describe("resolveEngineHome against a realistic project home", () => {
  /** 造一份贴近真实布局的旧 home：配置、索引、会话、技能、sqlite 三件套。 */
  function seedLegacyHome(home: string): string {
    const legacy = path.join(home, ".codex");
    fs.mkdirSync(path.join(legacy, "sessions", "2026", "11", "18"), { recursive: true });
    fs.mkdirSync(path.join(legacy, "skills", ".system", "imagegen"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "config.toml"), 'model = "deepseek-flash"\n');
    fs.writeFileSync(path.join(legacy, "installation_id"), "install-abc\n");
    fs.writeFileSync(
      path.join(legacy, "session_index.jsonl"),
      '{"id":"01a1ee21","thread_name":"Skills","updated_at":"2026-11-18T10:09:25.393Z"}\n',
    );
    fs.writeFileSync(
      path.join(legacy, "sessions", "2026", "11", "18", "rollout-01a1ee21.jsonl"),
      '{"type":"session_meta"}\n',
    );
    fs.writeFileSync(path.join(legacy, "skills", ".system", "imagegen", "SKILL.md"), "# imagegen\n");
    for (const name of ["state_5.sqlite", "state_5.sqlite-wal", "state_5.sqlite-shm"]) {
      fs.writeFileSync(path.join(legacy, name), "sqlite-bytes");
    }
    return legacy;
  }

  it("carries every piece of session state over and is idempotent", () => {
    const home = makeTempRoot();
    const legacy = seedLegacyHome(home);

    const resolved = resolveEngineHome(home);
    expect(resolved).toBe(path.join(home, ENGINE_HOME_DIR_NAME));
    expect(fs.existsSync(legacy)).toBe(false);

    // 会话可否恢复取决于这些：rollout + 索引 + 配置 + 技能
    expect(
      fs.readFileSync(
        path.join(resolved, "sessions/2026/11/18/rollout-01a1ee21.jsonl"),
        "utf8",
      ),
    ).toBe('{"type":"session_meta"}\n');
    expect(fs.readFileSync(path.join(resolved, "session_index.jsonl"), "utf8")).toContain(
      "01a1ee21",
    );
    expect(fs.readFileSync(path.join(resolved, "config.toml"), "utf8")).toContain(
      "deepseek-flash",
    );
    expect(fs.existsSync(path.join(resolved, "skills/.system/imagegen/SKILL.md"))).toBe(
      true,
    );
    // sqlite 三件套（含 WAL/SHM）必须一起搬，否则库会打不开
    for (const name of ["state_5.sqlite", "state_5.sqlite-wal", "state_5.sqlite-shm"]) {
      expect(fs.existsSync(path.join(resolved, name))).toBe(true);
    }
    expect(JSON.parse(fs.readFileSync(path.join(resolved, ".migration.json"), "utf8"))).toMatchObject(
      { from: ".codex", mode: "rename" },
    );

    // 二次调用必须幂等：不重建 .codex，也不多出备份
    expect(resolveEngineHome(home)).toBe(resolved);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.readdirSync(home).filter((n) => n.includes(".migrated-"))).toHaveLength(0);
  });

  it("merges into an existing new home and prefers its content on conflict", () => {
    const home = makeTempRoot();
    const legacy = seedLegacyHome(home);
    const target = path.join(home, ENGINE_HOME_DIR_NAME);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "config.toml"), 'model = "newer"\n');
    fs.mkdirSync(path.join(target, "sessions", "2026", "11", "17"), { recursive: true });
    fs.writeFileSync(path.join(target, "sessions/2026/11/17/newer.jsonl"), "{}\n");

    expect(resolveEngineHome(home)).toBe(target);
    // 冲突文件保留新目录的版本，旧的改名留档
    expect(fs.readFileSync(path.join(target, "config.toml"), "utf8")).toBe('model = "newer"\n');
    const keptOld = fs
      .readdirSync(target)
      .find((name) => name.startsWith("config.toml.from-legacy-"));
    expect(keptOld).toBeDefined();
    // 目录不冲突的部分双向保留（新会话 + 旧会话都在 sessions/ 下）
    expect(fs.existsSync(path.join(target, "sessions/2026/11/17/newer.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(target, "sessions/2026/11/18/rollout-01a1ee21.jsonl"))).toBe(
      true,
    );
    // 旧目录整体留作备份，可按需回滚
    expect(fs.readdirSync(home).some((n) => n.startsWith(".codex.migrated-"))).toBe(true);
    expect(fs.existsSync(legacy)).toBe(false);
  });
});

describe("migrateEngineSegment idempotency", () => {
  it("does nothing on the second call and leaves no extra backups", () => {
    const projectRoot = makeTempRoot();
    fs.mkdirSync(path.join(projectRoot, "codex-cli", "home", ".codex"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(projectRoot, "codex-cli", "home", ".codex", "installation_id"),
      "abc\n",
    );

    migrateEngineSegment(projectRoot, "codex-cli", "nuwax-harness");
    const backupsAfterFirst = fs
      .readdirSync(projectRoot)
      .filter((n) => n.includes(".migrated-"));

    migrateEngineSegment(projectRoot, "codex-cli", "nuwax-harness");

    expect(
      fs.readdirSync(projectRoot).filter((n) => n.includes(".migrated-")),
    ).toHaveLength(backupsAfterFirst.length);
    expect(
      fs.readFileSync(
        path.join(projectRoot, "nuwax-harness", "home", ".codex", "installation_id"),
        "utf8",
      ),
    ).toBe("abc\n");
  });
});

describe("pruneProjectIsolatedHomeCaches regression", () => {
  it("still prunes regular caches and honours skipPaths", () => {
    const root = makeTempRoot();
    const home = path.join(root, "6", "1", "nuwax-harness", "home");
    const skipHome = path.join(root, "6", "2", "nuwax-harness", "home");
    for (const dir of [home, skipHome]) {
      fs.mkdirSync(path.join(dir, ".cache"), { recursive: true });
      fs.mkdirSync(path.join(dir, ".npm"), { recursive: true });
    }
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    for (const dir of [home, skipHome]) {
      for (const name of [".cache", ".npm"]) {
        fs.utimesSync(path.join(dir, name), old, old);
      }
    }

    const pruned = pruneProjectIsolatedHomeCaches(2, {
      root,
      skipPaths: new Set([skipHome]),
    });

    expect(pruned).toBe(2); // 只清理未被 skip 的那份 home 的 .cache/.npm
    expect(fs.existsSync(path.join(home, ".cache"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".npm"))).toBe(false);
    expect(fs.existsSync(path.join(skipHome, ".cache"))).toBe(true);
    expect(fs.existsSync(path.join(skipHome, ".npm"))).toBe(true);
  });
});
