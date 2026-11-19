import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { AndroidDevice } from "@shared/features/android/contract";

export type AdbRun = (
  file: string,
  args: string[],
  signal: AbortSignal,
) => Promise<Buffer>;
export type AdbWatch = (
  device: AdbDevice,
  signal: AbortSignal,
  onLost: (reason: "deviceOffline" | "adbFailed") => void,
) => Promise<void>;

const ADB_TIMEOUT_MS = 15_000;

export function createAdbCommands(
  getEnv: () => NodeJS.ProcessEnv = () => process.env,
): { run: AdbRun; watch: AdbWatch } {
  const run: AdbRun = (file, args, signal) =>
    new Promise((resolve, reject) => {
      execFile(
        file,
        args,
        {
          env: getEnv(),
          encoding: "buffer",
          timeout: ADB_TIMEOUT_MS,
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

  const watch: AdbWatch = (device, signal, onLost) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("cancelled"));
        return;
      }
      // ADB sends a complete device list on each transport change using
      // four hexadecimal length bytes followed by its UTF-8 payload.
      const child = spawn(device.file, ["track-devices", "-l"], {
        env: getEnv(),
        signal,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      let buffered = Buffer.alloc(0);
      let ready = false;
      let failed = false;
      const fail = (reason: "deviceOffline" | "adbFailed") => {
        if (failed) return;
        failed = true;
        clearTimeout(timeout);
        if (!signal.aborted) child.kill();
        if (!ready) reject(new Error(signal.aborted ? "cancelled" : reason));
        else if (!signal.aborted) onLost(reason);
      };
      const timeout = setTimeout(() => fail("adbFailed"), ADB_TIMEOUT_MS);
      child.once("error", () => fail("adbFailed"));
      child.once("close", () => fail("adbFailed"));
      child.stdout.on("data", (chunk: Buffer) => {
        if (failed || signal.aborted) return;
        buffered = Buffer.concat([buffered, chunk]);
        while (buffered.length >= 4) {
          const header = buffered.toString("ascii", 0, 4);
          if (!/^[0-9a-f]{4}$/i.test(header)) {
            fail("adbFailed");
            return;
          }
          const frameEnd = 4 + Number.parseInt(header, 16);
          if (buffered.length < frameEnd) return;
          const devices = parseDevices(buffered.toString("utf8", 4, frameEnd));
          buffered = buffered.subarray(frameEnd);
          const connected = devices.some(
            ({ serial, state, transportId }) =>
              serial === device.serial &&
              state === "device" &&
              transportId === device.transportId,
          );
          if (!connected) {
            fail("deviceOffline");
            return;
          }
          if (!ready) {
            ready = true;
            clearTimeout(timeout);
            resolve();
          }
        }
      });
    });

  return { run, watch };
}

export function isAutomaticAdbPath(input: string): boolean {
  const value = input.trim();
  return !value || value === "adb";
}

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

type DetectedDevice = AndroidDevice & { transportId?: string };

export function parseDevices(text: string): DetectedDevice[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const match = line.match(
      /^(\S+)\s+(device|offline|unauthorized|recovery|sideload|bootloader|no permissions)(?:\s|$)(.*)/,
    );
    if (!match || !validSerial(match[1])) return [];
    const transportId = match[3].match(
      /(?:^|\s)transport_id:([1-9]\d{0,19})(?=\s|$)/,
    )?.[1];
    return [
      {
        ...(transportId ? { transportId } : {}),
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
    readonly transportId: string,
    private readonly run: AdbRun,
  ) {
    if (!validSerial(serial)) throw new Error("invalidDevice");
  }
  private command(args: string[], signal: AbortSignal) {
    // The same serial can reconnect. An action may only target the
    // transport the user explicitly authorized.
    return this.run(this.file, ["-t", this.transportId, ...args], signal);
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
