import * as fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;
const MAX_RECORD_BYTES = 64 * 1024;
const HANDOFF_TIMEOUT_MS = 15_000;
const CONFIRMATION_WAIT_MS = 15_000;
const MONITOR_MAX_AGE_MS = 4 * 60 * 60 * 1000;
const TERMINAL = new Set(["failed", "cancelled", "installer-exited", "confirmed"]);
const STATUSES = new Set([...TERMINAL, "ready", "running"]);

export interface WindowsUpdateJob {
  schemaVersion: 1;
  id: string;
  product: string;
  fromVersion: string;
  targetVersion: string;
  currentExe: string;
  installDirectory: string;
  installerPath: string;
  installerSha512: string;
  monitorSha256: string;
  parentPid: number;
  createdAt: string;
  messages: { title: string; failed: string; unconfirmed: string };
}
export interface WindowsUpdateReceipt {
  schemaVersion: 1;
  id: string;
  jobSha256: string;
  status: string;
  phase: string;
  updatedAt: string;
  monitorPid?: number;
  exitCode?: number;
  error?: string;
  installationCompleted?: boolean;
}
export interface WindowsUpdateRecovery {
  kind: "failed" | "interrupted" | "in-progress" | "corrupt";
  directory: string;
  targetVersion?: string;
  acknowledged: boolean;
  acknowledge(): void;
}

function readRecord(file: string): { bytes: Buffer; value: any } {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECORD_BYTES) throw new Error("Invalid update record.");
  const bytes = fs.readFileSync(file);
  if (bytes.length > MAX_RECORD_BYTES) throw new Error("Invalid update record size.");
  return { bytes, value: JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, "")) };
}
const json = (file: string): any => readRecord(file).value;
function atomicJson(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
function ownDirectory(directory: string): void {
  if (fs.existsSync(directory)) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Update directory is redirected.");
  } else {
    ownDirectory(path.dirname(directory));
    fs.mkdirSync(directory, { mode: 0o700 });
  }
}
function safeRecordDirectory(root: string, id: string): string {
  if (!UUID.test(id)) throw new Error("Invalid update transaction identity.");
  ownDirectory(root);
  const directory = path.join(root, id);
  ownDirectory(directory);
  return directory;
}
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export function windowsUpdateRoot(dataDirectory: string, executable: string): string {
  return path.join(dataDirectory, "updates", digest(path.win32.normalize(executable).toLowerCase()).slice(0, 32));
}
export async function hashWindowsInstaller(file: string): Promise<string> {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid downloaded installer.");
  const hash = createHash("sha512");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
function samePath(a: string, b: string): boolean {
  return path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();
}
function alive(pid?: number): boolean {
  if (!Number.isInteger(pid) || !pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error: any) { return error.code === "EPERM"; }
}
function activeMonitor(receipt: WindowsUpdateReceipt | null): boolean {
  return !!receipt && Math.abs(Date.now() - Date.parse(receipt.updatedAt)) < MONITOR_MAX_AGE_MS && alive(receipt.monitorPid);
}
function readReceipt(directory: string, job: WindowsUpdateJob, jobSha256: string): WindowsUpdateReceipt | null {
  try {
    const receipt = json(path.join(directory, "receipt.json"));
    if (receipt.schemaVersion !== 1 || receipt.id !== job.id || receipt.jobSha256 !== jobSha256
      || !STATUSES.has(receipt.status) || typeof receipt.phase !== "string"
      || typeof receipt.updatedAt !== "string" || !Number.isFinite(Date.parse(receipt.updatedAt))
      || ["installer-exited", "confirmed"].includes(receipt.status) && receipt.exitCode !== 0) throw new Error("Update receipt identity mismatch.");
    return receipt;
  } catch (error: any) { if (error.code === "ENOENT") return null; throw error; }
}

async function launchMonitor(executable: string, directory: string, jobSha256: string,
  env: NodeJS.ProcessEnv): Promise<number> {
  // The worker must not inherit a pipe that keeps the launcher's exit pending.
  const launcher = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", path.join(directory, "monitor.ps1"), "-JobPath", path.join(directory, "job.json"), "-JobSha256", jobSha256, "-Launch"],
  { windowsHide: true, stdio: "ignore", cwd: directory, env });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      launcher.kill();
      reject(new Error("Update monitor launcher did not exit."));
    }, HANDOFF_TIMEOUT_MS);
    launcher.once("error", error => { clearTimeout(timer); reject(error); });
    launcher.once("exit", code => { clearTimeout(timer); resolve(code); });
  });
  const fallbackError = `Update monitor launcher exited without a valid launch receipt (code ${exitCode}).`;
  let result;
  try {
    result = json(path.join(directory, "launch.json"));
  } catch (error: any) {
    if (error.code === "ENOENT") throw new Error(fallbackError);
    throw error;
  }
  if (result.id !== path.basename(directory) || result.jobSha256 !== jobSha256) {
    throw new Error("Update monitor launch receipt identity mismatch.");
  }
  if (exitCode !== 0) throw new Error(typeof result.error === "string" ? result.error : fallbackError);
  if (!Number.isInteger(result.monitorPid) || result.monitorPid <= 0 || result.monitorPid > 0xffffffff) {
    throw new Error(fallbackError);
  }
  return result.monitorPid;
}

export interface WindowsUpdateHandoff { commit(): void; cancel(): void }
export async function prepareWindowsUpdate(options: {
  root: string; resourcesPath: string; installerPath: string; currentExe: string;
  product: string;
  fromVersion: string; targetVersion: string; env: NodeJS.ProcessEnv;
  messages: WindowsUpdateJob["messages"];
}): Promise<WindowsUpdateHandoff> {
  const { root, currentExe, targetVersion, env } = options;
  ownDirectory(root);
  // A second launch must not start another installer while the first still owns it.
  let running = false;
  try {
    const active = json(path.join(root, "active.json"));
    const directory = safeRecordDirectory(root, active.id);
    const job = json(path.join(directory, "job.json"));
    const receipt = readReceipt(directory, job, active.jobSha256);
    running = !!receipt && !TERMINAL.has(receipt.status) && activeMonitor(receipt);
  } catch { /* A corrupt old record remains available for recovery diagnostics. */ }
  if (running) throw new Error("An update installer is already running.");
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? env.WINDIR;
  if (!systemRoot || !VERSION.test(targetVersion) || !/^[a-z][a-z0-9-]{0,48}$/.test(options.product)) throw new Error("Invalid Windows update environment or version.");
  const id = randomUUID(), directory = safeRecordDirectory(root, id);
  const script = fs.readFileSync(path.join(options.resourcesPath, "installer", "installer-monitor.ps1"));
  // Copy exact signed bytes before the old installation can be moved/deleted.
  const scriptPath = path.join(directory, "monitor.ps1");
  fs.writeFileSync(scriptPath, script, { flag: "wx", mode: 0o600 });
  const job: WindowsUpdateJob = {
    schemaVersion: 1, id, product: options.product, fromVersion: options.fromVersion, targetVersion, currentExe,
    installDirectory: path.win32.dirname(currentExe), installerPath: options.installerPath,
    installerSha512: await hashWindowsInstaller(options.installerPath), monitorSha256: digest(script),
    parentPid: process.pid, createdAt: new Date().toISOString(), messages: options.messages,
  };
  const serialized = JSON.stringify(job), jobSha256 = digest(serialized);
  fs.writeFileSync(path.join(directory, "job.json"), serialized, { flag: "wx", mode: 0o600 });
  atomicJson(path.join(root, "active.json"), { id, jobSha256 });
  const cancel = () => atomicJson(path.join(directory, "cancel.json"), { id, jobSha256 });
  try {
    const deadline = Date.now() + HANDOFF_TIMEOUT_MS;
    const monitorPid = await launchMonitor(
      path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      directory, jobSha256, env,
    );
    while (Date.now() < deadline) {
      const receipt = readReceipt(directory, job, jobSha256);
      if (receipt?.status === "failed") throw new Error(receipt.error || "Update monitor failed to initialize.");
      if (!alive(monitorPid)) throw new Error("Update monitor exited before handoff. See monitor.stderr.log.");
      if (receipt?.status === "ready" && receipt.monitorPid === monitorPid) {
        return {
          commit: () => {
            const current = readReceipt(directory, job, jobSha256);
            if (current?.status !== "ready" || current.monitorPid !== monitorPid || !alive(monitorPid)) {
              throw new Error("Update monitor is no longer ready.");
            }
            atomicJson(path.join(directory, "commit.json"), { id, jobSha256 });
          },
          cancel,
        };
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("Update monitor did not become ready.");
  } catch (error: any) {
    cancel();
    atomicJson(path.join(directory, "receipt.json"), {
      schemaVersion: 1, id, jobSha256, status: "failed", phase: "Handoff", error: error.message, updatedAt: new Date().toISOString(),
    });
    throw error;
  }
}

/** Exit code zero is insufficient: confirm the actually running version/copy. */
export async function inspectWindowsUpdate(options: {
  root: string; currentExe: string; currentVersion: string; waitMs?: number;
}): Promise<WindowsUpdateRecovery | null> {
  const { root } = options;
  const activeFile = path.join(root, "active.json");
  if (!fs.existsSync(activeFile)) return null;
  let directory = root, targetVersion: string | undefined;
  let fingerprint = "invalid";
  let recordIdentity: { id: string; jobSha256: string } | undefined;
  const recovery = (kind: WindowsUpdateRecovery["kind"]): WindowsUpdateRecovery => {
    const ackFile = path.join(directory, "acknowledged.json");
    let acknowledged = false;
    try { acknowledged = json(ackFile).fingerprint === fingerprint; } catch {}
    return { kind, directory, targetVersion, acknowledged,
      acknowledge: () => {
        ownDirectory(directory);
        atomicJson(ackFile, { fingerprint, ...recordIdentity, at: new Date().toISOString() });
      } };
  };
  try {
    ownDirectory(root);
    const activeRecord = readRecord(activeFile);
    fingerprint = digest(activeRecord.bytes);
    const active = activeRecord.value;
    directory = safeRecordDirectory(root, active.id);
    const jobFile = path.join(directory, "job.json");
    const jobRecord = readRecord(jobFile);
    if (digest(jobRecord.bytes) !== active.jobSha256) throw new Error("Update job digest mismatch.");
    const job: WindowsUpdateJob = jobRecord.value;
    if (job.schemaVersion !== 1 || job.id !== active.id || !VERSION.test(job.targetVersion) || !/^[a-z][a-z0-9-]{0,48}$/.test(job.product)
      || !samePath(path.win32.dirname(job.currentExe), job.installDirectory)) throw new Error("Invalid update job identity.");
    if (!samePath(job.currentExe, options.currentExe)) return null;
    recordIdentity = { id: job.id, jobSha256: active.jobSha256 };
    targetVersion = job.targetVersion;
    const deadline = Date.now() + (options.waitMs ?? CONFIRMATION_WAIT_MS);
    let receipt = readReceipt(directory, job, active.jobSha256);
    while (receipt && !TERMINAL.has(receipt.status) && options.currentVersion === targetVersion && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 250));
      receipt = readReceipt(directory, job, active.jobSha256);
    }
    if (json(activeFile).id !== job.id) return null;
    if (receipt?.status === "failed" || receipt?.status === "cancelled") return recovery("failed");
    if (receipt?.status === "confirmed" || receipt?.status === "installer-exited" && receipt.exitCode === 0) {
      if (options.currentVersion !== targetVersion) return recovery("failed");
      // An unchanged version cannot distinguish a successful reinstall from
      // cancellation; require the installer's post-restore completion marker.
      if (job.fromVersion === targetVersion && receipt.installationCompleted !== true) return recovery("interrupted");
      atomicJson(path.join(directory, "confirmed.json"), { id: job.id, jobSha256: active.jobSha256, version: options.currentVersion, exe: options.currentExe });
      // Another update may have started while this receipt was being inspected.
      if (json(activeFile).id === job.id) fs.unlinkSync(activeFile);
      return null;
    }
    return recovery(activeMonitor(receipt) ? "in-progress" : "interrupted");
  } catch {
    // Corrupt records are diagnostic input, never authority to execute a file.
    return recovery("corrupt");
  }
}
