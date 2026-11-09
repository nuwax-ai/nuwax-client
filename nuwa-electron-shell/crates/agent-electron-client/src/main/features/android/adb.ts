import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { AndroidDevice } from "@shared/features/android/contract";

export type AdbRun = (
  file: string,
  args: string[],
  signal: AbortSignal,
) => Promise<Buffer>;
export const runAdb: AdbRun = (file, args, signal) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: "buffer",
        timeout: 15_000,
        maxBuffer: 12 * 1024 * 1024,
        windowsHide: true,
        signal,
      },
      (error, stdout) => {
        if (error)
          reject(
            new Error(
              signal.aborted
                ? "cancelled"
                : (error as NodeJS.ErrnoException).code === "ENOENT"
                  ? "adbMissing"
                  : "adbFailed",
            ),
          );
        else resolve(stdout);
      },
    );
  });

export function resolveAdbPath(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length > 4096 ||
    /[\r\n\0]/.test(input)
  )
    throw new Error("invalidPath");
  const value = input.trim();
  if (value && value !== "adb" && !path.isAbsolute(value))
    throw new Error("invalidPath");
  if (value && value !== "adb") return value;
  return (
    ["/opt/homebrew/bin/adb", "/usr/local/bin/adb"].find(existsSync) ?? "adb"
  );
}

export function parseDevices(text: string): AndroidDevice[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const match = line.match(
      /^(\S+)\s+(device|offline|unauthorized|recovery|sideload|bootloader|no permissions)(?:\s|$)(.*)/,
    );
    if (!match || !validSerial(match[1])) return [];
    return [
      {
        serial: match[1],
        state: match[2],
        model:
          match[3].match(/(?:^|\s)model:(\S+)/)?.[1]?.replace(/_/g, " ") ??
          match[1],
      },
    ];
  });
}

export const validSerial = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-zA-Z0-9][a-zA-Z0-9._:[\]-]{0,255}$/.test(value);

export class AdbDevice {
  constructor(
    readonly file: string,
    readonly serial: string,
    private run: AdbRun = runAdb,
  ) {
    if (!validSerial(serial)) throw new Error("invalidDevice");
  }
  private command(args: string[], signal: AbortSignal) {
    return this.run(this.file, ["-s", this.serial, ...args], signal);
  }
  async assertOnline(signal: AbortSignal) {
    const state = (await this.command(["get-state"], signal)).toString().trim();
    if (state !== "device") throw new Error("deviceOffline");
  }
  async screenshot(signal: AbortSignal) {
    const data = await this.command(["exec-out", "screencap", "-p"], signal);
    if (
      data.length < 33 ||
      !data
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      data.toString("ascii", 12, 16) !== "IHDR"
    )
      throw new Error("invalidScreenshot");
    const width = data.readUInt32BE(16),
      height = data.readUInt32BE(20);
    if (!width || !height || width > 16384 || height > 16384)
      throw new Error("invalidScreenshot");
    return { data, width, height };
  }
  async input(words: string[], signal: AbortSignal) {
    // adb 会再次把参数拼成远端 shell 命令，不能只依赖主机 execFile 的无 shell 保证。
    const quote = (word: string) => "'" + word.replace(/'/g, "'\\''") + "'";
    await this.command(["shell", ...["input", ...words].map(quote)], signal);
  }
}
