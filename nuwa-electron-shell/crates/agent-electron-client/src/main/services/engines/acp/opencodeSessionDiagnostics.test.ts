import { afterEach, beforeEach, describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  getOpencodeDataDir,
  readEngineLogTail,
  snapshotOpencodePersistence,
} from "./opencodeSessionDiagnostics";

describe("opencodeSessionDiagnostics", () => {
  it("getOpencodeDataDir resolves under isolated HOME", () => {
    expect(getOpencodeDataDir("/tmp/iso-home")).toBe(
      path.join("/tmp/iso-home", ".local", "share", "opencode"),
    );
  });

  it("snapshotOpencodePersistence counts session info json files", () => {
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "iso-"));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "proj-"));
    const dataDir = getOpencodeDataDir(isolated);
    const infoDir = path.join(dataDir, "storage", "session", "info");
    fs.mkdirSync(infoDir, { recursive: true });
    fs.writeFileSync(path.join(infoDir, "ses_test.json"), "{}");
    fs.writeFileSync(path.join(dataDir, "opencode.db"), "x");

    const snap = snapshotOpencodePersistence(isolated, project);
    expect(snap.opencodeDataExists).toBe(true);
    expect(snap.sessionInfoJsonCount).toBe(1);
    expect(snap.dbFiles).toEqual([{ name: "opencode.db", bytes: 1 }]);

    fs.rmSync(isolated, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });
});

describe("readEngineLogTail（session-setup-ha）", () => {
  let isolated: string;

  beforeEach(() => {
    isolated = fs.mkdtempSync(path.join(os.tmpdir(), "iso-log-"));
  });

  afterEach(() => {
    fs.rmSync(isolated, { recursive: true, force: true });
  });

  const logPath = () =>
    path.join(getOpencodeDataDir(isolated), "log", "opencode.log");

  it("读取 <home>/.local/share/opencode/log/opencode.log 的末尾若干行", () => {
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    fs.writeFileSync(
      logPath(),
      Array.from({ length: 200 }, (_, i) => `line-${i}\n`).join(""),
    );

    const tail = readEngineLogTail(isolated, { maxLines: 3 });

    expect(tail).toMatchObject({ exists: true, truncated: false, path: logPath() });
    expect(tail!.lines).toEqual(["line-197", "line-198", "line-199"]);
  });

  it("文件超过字节上限时只读末尾，并丢掉被截断的首行", () => {
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    const lines = Array.from({ length: 500 }, (_, i) => `entry-${String(i).padStart(4, "0")}\n`);
    fs.writeFileSync(logPath(), lines.join(""));

    const tail = readEngineLogTail(isolated, { maxBytes: 2_000, maxLines: 1_000 });

    expect(tail!.truncated).toBe(true);
    expect(tail!.lines.length).toBeGreaterThan(100);
    expect(tail!.lines.length).toBeLessThan(500);
    // 首行从中间被截断，已丢弃；末尾完整
    expect(tail!.lines[0]).toMatch(/^entry-\d{4}$/);
    expect(tail!.lines.at(-1)).toBe("entry-0499");
  });

  it("逐行脱敏后才返回", () => {
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    fs.writeFileSync(
      logPath(),
      'timestamp=... message="request" api_key="sk-abcdef1234567890"\n',
    );

    const tail = readEngineLogTail(isolated);

    expect(tail!.lines[0]).not.toContain("sk-abcdef1234567890");
    expect(tail!.lines[0]).toContain("request");
  });

  it("没有 isolated home 或日志还不存在时如实返回", () => {
    expect(readEngineLogTail(null)).toBeNull();
    expect(readEngineLogTail(isolated)).toMatchObject({
      exists: false,
      truncated: false,
      lines: [],
    });
  });
});
