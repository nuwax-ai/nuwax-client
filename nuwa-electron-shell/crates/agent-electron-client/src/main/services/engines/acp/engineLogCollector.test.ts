/**
 * 单元测试: 引擎日志收集与导出附加条目（session-setup-ha）
 */

import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ENGINE_LOG_EXPORT_TAIL_BYTES,
  collectEngineLogFiles,
} from "./engineLogCollector";
import { getSessionSetupDiagnostics } from "./sessionSetupDiagnostics";
import { buildDiagnosticArchiveExtras } from "../sessionSetupArchiveExtras";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nuwax-engine-log-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeEngineLog(
  root: string,
  segments: string[],
  content: string,
  mtimeDaysAgo = 0,
): string {
  const logPath = path.join(root, ...segments, ".local", "share", "opencode", "log", "opencode.log");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, content);
  if (mtimeDaysAgo > 0) {
    const old = new Date(Date.now() - mtimeDaysAgo * 24 * 60 * 60 * 1000);
    fs.utimesSync(logPath, old, old);
  }
  return logPath;
}

describe("collectEngineLogFiles", () => {
  it("只收集 home 与隔离备份里的引擎日志，路径映射为 engine-logs/<user>/<id>/<engine>/…", () => {
    const root = makeTempRoot();
    writeEngineLog(root, ["u1", "1759004", "nuwaxcode", "home"], "log a");
    writeEngineLog(
      root,
      ["u1", "1759004", "nuwaxcode", "home.quarantine-20261125142039"],
      "old log",
      3,
    );

    const files = collectEngineLogFiles({ projectsRoot: root });

    expect(files.map((file) => file.archiveName)).toEqual([
      "engine-logs/u1/1759004/nuwaxcode/home/opencode.log",
      "engine-logs/u1/1759004/nuwaxcode/home.quarantine-20261125142039/opencode.log",
    ]);
    expect(files[0].source.endsWith(path.join("home", ".local", "share", "opencode", "log", "opencode.log"))).toBe(true);
  });

  it("忽略空日志、无关目录与会话库，越深的层级不展开", () => {
    const root = makeTempRoot();
    writeEngineLog(root, ["u1", "1759004", "nuwaxcode", "home"], "");
    // 迁移备份结构不同，不在这里收
    fs.mkdirSync(
      path.join(root, "u1", "1759004", "codex-cli.migrated-2026-01-01", "home", ".local"),
      { recursive: true },
    );
    // 会话库不是日志
    const db = path.join(root, "u1", "1759005", "nuwaxcode", "home", ".local", "share", "opencode", "opencode.db");
    fs.mkdirSync(path.dirname(db), { recursive: true });
    fs.writeFileSync(db, "session data");

    expect(collectEngineLogFiles({ projectsRoot: root })).toEqual([]);
  });

  it("目录不存在时返回空；按最近修改取前 limit 份", () => {
    expect(collectEngineLogFiles({ projectsRoot: path.join(os.tmpdir(), "missing-root-xyz") })).toEqual([]);

    const root = makeTempRoot();
    writeEngineLog(root, ["u1", "p-new", "nuwaxcode", "home"], "new");
    writeEngineLog(root, ["u1", "p-old", "nuwaxcode", "home"], "old", 5);

    const files = collectEngineLogFiles({ projectsRoot: root, limit: 1 });
    expect(files).toHaveLength(1);
    expect(files[0].archiveName).toContain("p-new");
  });
});

describe("buildDiagnosticArchiveExtras", () => {
  it("始终带会话建立诊断 JSON，并给每份引擎日志限定尾部字节数", () => {
    const diagnostics = getSessionSetupDiagnostics();
    const extras = buildDiagnosticArchiveExtras({
      diagnostics,
      engineLogFiles: [
        { source: "/h/opencode.log", archiveName: "engine-logs/a/opencode.log", mtimeMs: 1 },
      ],
    });

    expect(extras[0]).toEqual({
      name: "diagnostics/session-setup.json",
      content: expect.any(Buffer),
    });
    expect(JSON.parse(extras[0].content!.toString("utf8"))).toEqual(diagnostics);
    expect(extras[1]).toEqual({
      name: "engine-logs/a/opencode.log",
      source: "/h/opencode.log",
      tailBytes: ENGINE_LOG_EXPORT_TAIL_BYTES,
    });
  });
});
