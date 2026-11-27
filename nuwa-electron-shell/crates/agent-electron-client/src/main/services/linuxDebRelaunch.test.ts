import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { scheduleLinuxDebRelaunch } from "./linuxDebRelaunch";

it.skipIf(process.platform === "win32")("relaunches only after the old process exits, with the original arguments", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nuwax-deb-relaunch-"));
  const resultPath = join(directory, "relaunch.json");
  const parent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    await once(parent, "spawn");
    const resultWriter = `
      const [file, ...args] = process.argv.slice(1);
      require("node:fs").writeFileSync(file, JSON.stringify({
        args, nodeMode: process.env.ELECTRON_RUN_AS_NODE ?? null,
      }));
    `;
    const args = ["--ozone-platform=x11", "path with spaces"];
    await scheduleLinuxDebRelaunch({
      executable: process.execPath,
      args: ["-e", resultWriter, "--", resultPath, ...args],
      logPath: join(directory, "update-install.log"),
      parentPid: parent.pid!,
    });
    await setTimeout(200);
    expect(existsSync(resultPath)).toBe(false);

    const exited = once(parent, "exit");
    parent.kill();
    await exited;
    await vi.waitFor(() => {
      expect(JSON.parse(readFileSync(resultPath, "utf8"))).toEqual({ args, nodeMode: null });
    }, { timeout: 3000 });
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) {
      const exited = once(parent, "exit");
      parent.kill();
      await exited;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
