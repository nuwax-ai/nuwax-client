import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { hashWindowsInstaller, inspectWindowsUpdate, prepareWindowsUpdate, windowsUpdateRoot, type WindowsUpdateJob } from "./windowsUpdateSession";

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: launch }));
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const exe = "C:\\Program Files\\Nuwax\\Nuwax.exe";
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "windows-update-session-"));
  launch.mockReset();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function record(status?: string, exitCode?: number, fromVersion = "3.1.3",
  targetVersion = "3.2.0", phase = "InstallerExited") {
  const id = randomUUID(), directory = path.join(root, id);
  fs.mkdirSync(directory);
  const job: WindowsUpdateJob = {
    schemaVersion: 1, id, product: "nuwax", fromVersion, targetVersion,
    currentExe: exe, installDirectory: path.win32.dirname(exe), installerPath: "C:\\cache\\setup.exe",
    installerSha512: "a".repeat(128), monitorSha256: "b".repeat(64),
    parentPid: 1, createdAt: new Date().toISOString(),
    messages: { title: "Recovery", failed: "Failed", unconfirmed: "Unconfirmed" },
  };
  const text = JSON.stringify(job), jobSha256 = sha(text);
  fs.writeFileSync(path.join(directory, "job.json"), text);
  fs.writeFileSync(path.join(root, "active.json"), JSON.stringify({ id, jobSha256 }));
  if (status) fs.writeFileSync(path.join(directory, "receipt.json"), JSON.stringify({
    schemaVersion: 1, id, jobSha256, status, phase, exitCode,
    updatedAt: new Date().toISOString(),
  }));
  return { id, directory, job, jobSha256 };
}
const inspect = (currentVersion = "3.1.3", currentExe = exe) =>
  inspectWindowsUpdate({ root, currentExe, currentVersion, waitMs: 0 });

describe("Windows update startup confirmation", () => {
  it("isolates product profiles and installation directories while normalizing case", () => {
    expect(windowsUpdateRoot(root, exe)).toBe(windowsUpdateRoot(root, exe.toLowerCase()));
    expect(windowsUpdateRoot(root, exe)).not.toBe(windowsUpdateRoot(root, "D:\\Nuwax\\Nuwax.exe"));
    expect(windowsUpdateRoot(root, exe)).not.toBe(windowsUpdateRoot(path.join(root, "other-product"), exe));
  });
  it("confirms a zero exit only from the actual target version and installed copy", async () => {
    const { directory, id } = record("installer-exited", 0);
    expect(await inspect("3.2.0", exe.toLowerCase())).toBeNull();
    expect(JSON.parse(fs.readFileSync(path.join(directory, "confirmed.json"), "utf8"))).toMatchObject({ id, version: "3.2.0" });
    expect(fs.existsSync(path.join(root, "active.json"))).toBe(false);
    expect(fs.existsSync(path.join(directory, "job.json"))).toBe(true);
  });
  it("does not treat cancellation or a zero exit on the old version as success", async () => {
    const { directory } = record("installer-exited", 0);
    expect(await inspect()).toMatchObject({ kind: "failed", targetVersion: "3.2.0", directory });
    expect(fs.existsSync(path.join(directory, "confirmed.json"))).toBe(false);
  });
  it("keeps a failed restoration visible even when the new executable can start", async () => {
    record("failed", 2);
    expect(await inspect("3.2.0")).toMatchObject({ kind: "failed" });
  });
  it.each(["3.2.0-beta.7", "3.2.0-beta.8"])(
    "retires an old pre-handoff failure after a full upgrade to %s while keeping the original receipt",
    async version => {
      const { directory, id } = record("failed", undefined, "3.2.0-beta.4", "3.2.0-beta.7", "Handoff");
      expect(await inspect("3.2.0-beta.4")).toMatchObject({ kind: "failed" });
      expect(await inspect("3.2.0-beta.6")).toMatchObject({ kind: "failed" });
      expect(await inspect(version)).toBeNull();
      expect(fs.existsSync(path.join(root, "active.json"))).toBe(false);
      expect(JSON.parse(fs.readFileSync(path.join(directory, "receipt.json"), "utf8"))).toMatchObject({ status: "failed" });
      expect(JSON.parse(fs.readFileSync(path.join(directory, "superseded.json"), "utf8"))).toMatchObject({ id, version });
    },
  );
  it("does not retire a handoff failure after a commit was recorded", async () => {
    const { directory, id, jobSha256 } = record("failed", undefined, "3.2.0-beta.4", "3.2.0-beta.7", "Handoff");
    fs.writeFileSync(path.join(directory, "commit.json"), JSON.stringify({ id, jobSha256 }));
    expect(await inspect("3.2.0-beta.8")).toMatchObject({ kind: "failed" });
  });
  it.each(["3.2.0-beta.6", "3.2.0-beta.7"])("keeps a failed downgrade or same-version install visible (%s)", async target => {
    record("failed", undefined, "3.2.0-beta.7", target, "Handoff");
    expect(await inspect("3.2.0-beta.7")).toMatchObject({ kind: "failed" });
  });
  it.each([false, true])("same-version signed-package reinstall requires native completion (marker: %s)", async installationCompleted => {
    const { directory } = record("installer-exited", 0, "3.2.0");
    const file = path.join(directory, "receipt.json");
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), installationCompleted }));
    if (installationCompleted) expect(await inspect("3.2.0")).toBeNull();
    else expect(await inspect("3.2.0")).toMatchObject({ kind: "interrupted" });
  });
  it.each([undefined, "running"])("detects missing/incomplete receipts after a monitor disappears (%s)", async status => {
    record(status);
    expect(await inspect()).toMatchObject({ kind: "interrupted" });
  });
  it("recognizes a still-running monitor without suggesting a second installation", async () => {
    const { directory } = record("running");
    const file = path.join(directory, "receipt.json");
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), monitorPid: process.pid }));
    expect(await inspect()).toMatchObject({ kind: "in-progress" });
  });
  it("does not consume another installed copy's attempt", async () => {
    record("installer-exited", 0);
    expect(await inspect("3.2.0", "D:\\Other Nuwax\\Nuwax.exe")).toBeNull();
    expect(fs.existsSync(path.join(root, "active.json"))).toBe(true);
  });
  it("allows dismissing once while retaining the failed receipt and diagnostics", async () => {
    const { directory, id, jobSha256 } = record("failed", 2);
    const issue = (await inspect())!;
    expect(issue.acknowledged).toBe(false);
    issue.acknowledge();
    expect(await inspect()).toMatchObject({ kind: "failed", acknowledged: true });
    expect(JSON.parse(fs.readFileSync(path.join(directory, "acknowledged.json"), "utf8"))).toMatchObject({ id, jobSha256 });
    expect(fs.existsSync(path.join(directory, "receipt.json"))).toBe(true);
  });
  it.each(["job", "receipt", "active"])("retains corrupt %s data as diagnostics and never confirms it", async kind => {
    const { directory } = record("installer-exited", 0);
    const file = kind === "active" ? path.join(root, "active.json") : path.join(directory, kind + ".json");
    fs.writeFileSync(file, "{broken");
    expect(await inspect("3.2.0")).toMatchObject({ kind: "corrupt" });
    expect(fs.existsSync(path.join(directory, "confirmed.json"))).toBe(false);
    expect(launch).not.toHaveBeenCalled();
  });
  it("rejects a receipt from another attempt", async () => {
    const { directory } = record("installer-exited", 0);
    const file = path.join(directory, "receipt.json");
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), id: randomUUID() }));
    expect(await inspect("3.2.0")).toMatchObject({ kind: "corrupt" });
  });
  it("rejects a path traversal attempt in the active pointer", async () => {
    fs.writeFileSync(path.join(root, "active.json"), JSON.stringify({ id: "../outside" }));
    expect(await inspect()).toMatchObject({ kind: "corrupt", directory: root });
    expect(fs.existsSync(path.join(root, "outside"))).toBe(false);
  });
  it("rejects oversized diagnostics without trying to parse or confirm them", async () => {
    const { directory } = record("installer-exited", 0);
    fs.writeFileSync(path.join(directory, "job.json"), "x".repeat(70 * 1024));
    expect(await inspect("3.2.0")).toMatchObject({ kind: "corrupt" });
    expect(fs.existsSync(path.join(directory, "confirmed.json"))).toBe(false);
  });
});

describe("Windows update monitor handoff", () => {
  function input() {
    const resourcesPath = path.join(root, "resources");
    fs.mkdirSync(path.join(resourcesPath, "installer"), { recursive: true });
    const script = Buffer.from("# Signed monitor bytes\r\n# SIG # Begin signature block\r\n# SIG # End signature block\r\n");
    fs.writeFileSync(path.join(resourcesPath, "installer", "installer-monitor.ps1"), script);
    const installerPath = path.join(root, "setup.exe");
    fs.writeFileSync(installerPath, "downloaded installer bytes");
    return { root: path.join(root, "updates"), resourcesPath, installerPath, currentExe: exe, product: "nuwax",
      fromVersion: "3.1.3", targetVersion: "3.2.0", env: { SystemRoot: "C:\\Windows" },
      messages: { title: "Recovery", failed: "Failed", unconfirmed: "Unconfirmed" } };
  }
  function launcherExit(code: number) {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", code));
    return child;
  }
  function readyChild() {
    launch.mockImplementation((_file, args) => {
      const jobFile = args[args.indexOf("-JobPath") + 1];
      const jobSha256 = args[args.indexOf("-JobSha256") + 1];
      const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
      fs.writeFileSync(path.join(path.dirname(jobFile), "launch.json"), JSON.stringify({
        id: job.id, jobSha256, monitorPid: process.pid,
      }));
      fs.writeFileSync(path.join(path.dirname(jobFile), "receipt.json"), JSON.stringify({
        schemaVersion: 1, id: job.id, jobSha256, status: "ready", phase: "Handoff", monitorPid: process.pid,
        updatedAt: new Date().toISOString(),
      }));
      return launcherExit(0);
    });
  }
  it("keeps signed bytes, hashes the verified download and waits for readiness before commit", async () => {
    const options = input();
    readyChild();
    const handoff = await prepareWindowsUpdate(options);
    const active = JSON.parse(fs.readFileSync(path.join(options.root, "active.json"), "utf8"));
    const directory = path.join(options.root, active.id);
    const job = JSON.parse(fs.readFileSync(path.join(directory, "job.json"), "utf8"));
    expect(job.installerSha512).toBe(await hashWindowsInstaller(options.installerPath));
    expect(fs.readFileSync(path.join(directory, "monitor.ps1"))).toEqual(fs.readFileSync(path.join(options.resourcesPath, "installer", "installer-monitor.ps1")));
    expect(fs.existsSync(path.join(directory, "commit.json"))).toBe(false);
    handoff.commit();
    expect(JSON.parse(fs.readFileSync(path.join(directory, "commit.json"), "utf8"))).toEqual(active);
    expect(launch.mock.calls[0][1]).toContain("-Launch");
    expect(launch.mock.calls[0][2]).toMatchObject({ windowsHide: true, stdio: "ignore" });
    expect(launch.mock.calls[0][2].detached).toBeUndefined();
    expect(launch.mock.calls[0][2].shell).toBeUndefined();
    handoff.cancel();
    expect(fs.existsSync(path.join(directory, "cancel.json"))).toBe(true);
  });
  it("persists a failed handoff when the signed monitor cannot start", async () => {
    const options = input();
    launch.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("error", new Error("App Control blocked monitor")));
      return child;
    });
    await expect(prepareWindowsUpdate(options)).rejects.toThrow("App Control blocked monitor");
    expect(await inspectWindowsUpdate({ root: options.root, currentExe: exe, currentVersion: "3.1.3", waitMs: 0 })).toMatchObject({ kind: "failed" });
  });
  it("does not treat exit code zero without a worker PID as a successful launch", async () => {
    const options = input();
    launch.mockImplementation(() => launcherExit(0));
    await expect(prepareWindowsUpdate(options)).rejects.toThrow("without a valid launch receipt (code 0)");
    expect(await inspectWindowsUpdate({ root: options.root, currentExe: exe, currentVersion: "3.1.3", waitMs: 0 })).toMatchObject({ kind: "failed" });
  });
  it("rejects a monitor that exits between readiness and commit", async () => {
    const options = input();
    readyChild();
    const handoff = await prepareWindowsUpdate(options);
    const liveness = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("Monitor exited"), { code: "ESRCH" });
    });
    try {
      expect(() => handoff.commit()).toThrow("no longer ready");
    } finally {
      liveness.mockRestore();
    }
    const active = JSON.parse(fs.readFileSync(path.join(options.root, "active.json"), "utf8"));
    expect(fs.existsSync(path.join(options.root, active.id, "commit.json"))).toBe(false);
    handoff.cancel();
  });
  it("rejects redirected storage before it can write a job", async () => {
    const options = input();
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, options.root, process.platform === "win32" ? "junction" : "dir");
    await expect(prepareWindowsUpdate(options)).rejects.toThrow("redirected");
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(launch).not.toHaveBeenCalled();
  });
});
