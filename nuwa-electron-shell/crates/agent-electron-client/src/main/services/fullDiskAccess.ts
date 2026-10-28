/** macOS FDA uses a fresh child probe; reads never display UI or request permissions. */
import { spawn } from "node:child_process";
import log from "electron-log";
import { readSetting } from "../db";
import { openMacPrivacySettings } from "./system/macPermissions";

export const FULL_DISK_ACCESS_SETTING_KEY = "nuwax.fullDiskAccessPrompt";
const FDA_PROBE_PATH = "/Library/Application Support/com.apple.TCC/TCC.db";
const FDA_PROBE_SCRIPT =
  'try{const fs=require("fs");const fd=fs.openSync(process.argv[1],"r");fs.closeSync(fd);process.exit(0)}catch(e){process.exit(e&&["EACCES","EPERM"].includes(e.code)?2:3)}';
const PROBE_TIMEOUT_MS = 5000;
export type FullDiskAccessProbeStatus = "granted" | "denied" | "unknown";
export interface FullDiskAccessStatus {
  supported: boolean;
  granted: boolean;
  probeStatus: FullDiskAccessProbeStatus;
  dismissed: boolean;
}
export function isFullDiskAccessSupported(): boolean {
  return process.platform === "darwin";
}

// A newly granted FDA does not update file-server/engine processes already running.
// A fresh Electron child has the same TCC identity and can observe the new grant.
export async function probeFullDiskAccess(): Promise<FullDiskAccessProbeStatus> {
  if (!isFullDiskAccessSupported()) return "granted";
  return new Promise<FullDiskAccessProbeStatus>((resolve) => {
    let child;
    try {
      child = spawn(
        process.execPath,
        ["-e", FDA_PROBE_SCRIPT, FDA_PROBE_PATH],
        {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          stdio: ["ignore", "ignore", "ignore"],
        },
      );
    } catch (e) {
      log.warn("[FullDiskAccess] probe spawn failed (inconclusive):", e);
      resolve("unknown");
      return;
    }
    // settled 守卫：超时/error/close 可能交错，保证只 resolve 一次
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      log.warn(
        `[FullDiskAccess] probe timed out after ${PROBE_TIMEOUT_MS}ms (inconclusive)`,
      );
      resolve("unknown");
    }, PROBE_TIMEOUT_MS);
    timer.unref?.();
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log.warn(
        `[FullDiskAccess] probe spawn error (inconclusive): ${err.message}`,
      );
      resolve("unknown");
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve("granted");
      } else if (code === 2) {
        resolve("denied");
      } else {
        log.warn(`[FullDiskAccess] probe exited without result (exit=${code})`);
        resolve("unknown");
      }
    });
  });
}

export async function checkFullDiskAccess(): Promise<boolean> {
  return (await probeFullDiskAccess()) !== "denied";
}
export function isFullDiskAccessPromptDismissed(): boolean {
  const raw = readSetting(FULL_DISK_ACCESS_SETTING_KEY);
  return (
    raw === true ||
    (typeof raw === "object" &&
      raw !== null &&
      (raw as { dismissed?: unknown }).dismissed === true)
  );
}
export async function getFullDiskAccessStatus(): Promise<FullDiskAccessStatus> {
  const probeStatus = await probeFullDiskAccess();
  return {
    supported: isFullDiskAccessSupported(),
    granted: probeStatus === "granted",
    probeStatus,
    dismissed: isFullDiskAccessPromptDismissed(),
  };
}
export async function openFullDiskAccessSettings(): Promise<boolean> {
  return openMacPrivacySettings("file_access");
}
