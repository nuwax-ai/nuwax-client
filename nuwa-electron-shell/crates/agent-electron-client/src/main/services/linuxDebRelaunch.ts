import { spawn } from "node:child_process";
import { accessSync, closeSync, constants, openSync } from "node:fs";

// Electron's Chromium helper adds NoNewPrivs before launching the next app
// on Linux (electron/electron#55528). Hand off from the existing user process
// to preserve its launch environment and privilege restrictions.
const RELAUNCH_SCRIPT = `
const { spawn } = require("node:child_process");
const [parentPid, ...args] = process.argv.slice(1);
const deadline = Date.now() + 30_000;

function fail(error) {
  console.error("[Deb relaunch]", error);
  process.exitCode = 1;
}

function relaunchAfterExit() {
  try {
    process.kill(Number(parentPid), 0);
  } catch (error) {
    if (error.code !== "ESRCH") return fail(error);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", env });
    child.once("error", fail);
    child.unref();
    return;
  }
  if (Date.now() < deadline) setTimeout(relaunchAfterExit, 100);
  else fail("Timed out waiting for the previous process to exit.");
}

relaunchAfterExit();
`;

export async function scheduleLinuxDebRelaunch({
  executable,
  args,
  logPath,
  parentPid = process.pid,
}: {
  executable: string;
  args: string[];
  logPath: string;
  parentPid?: number;
}): Promise<void> {
  accessSync(executable, constants.X_OK);
  const fd = openSync(logPath, "a");
  try {
    const child = spawn(executable, ["-e", RELAUNCH_SCRIPT, "--", String(parentPid), ...args], {
      detached: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", fd, fd],
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
  } finally {
    closeSync(fd);
  }
}
