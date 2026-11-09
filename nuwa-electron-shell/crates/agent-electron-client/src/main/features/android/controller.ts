import { randomUUID } from "node:crypto";
import type { AndroidStatus } from "@shared/features/android/contract";
import {
  AdbDevice,
  parseDevices,
  resolveAdbPath,
  runAdb,
  type AdbRun,
} from "./adb";

type Observation = { id: string; width: number; height: number; at: number };
export class AndroidController {
  private device: AdbDevice | null = null;
  private epoch = 0;
  private owners = new Set<string>();
  private observations = new Map<string, Observation>();
  private job: { owner: string; abort: AbortController } | null = null;
  private pending = new Set<AbortController>();
  private error: string | undefined;
  constructor(
    private authenticated: () => boolean,
    private changed: () => void,
    private run: AdbRun = runAdb,
    private now = Date.now,
  ) {}
  status(): AndroidStatus {
    return {
      enabled: !!this.device,
      serial: this.device?.serial ?? null,
      adbPath: this.device?.file ?? "",
      error: this.error,
    };
  }
  stop(error?: string) {
    ++this.epoch;
    this.device = null;
    this.error = error;
    this.owners.clear();
    this.observations.clear();
    for (const abort of this.pending) abort.abort();
    this.pending.clear();
    this.changed();
  }
  start(owner: string) {
    this.cancel(owner);
    this.owners.add(owner);
  }
  cancel(owner: string) {
    this.owners.delete(owner);
    this.observations.delete(owner);
    if (this.job?.owner === owner) this.job.abort.abort();
  }
  async discover(input: string) {
    if (!this.authenticated()) throw new Error("loginRequired");
    const file = resolveAdbPath(input),
      abort = new AbortController();
    this.pending.add(abort);
    try {
      const version = (
        await this.run(file, ["version"], abort.signal)
      ).toString();
      if (!version.includes("Android Debug Bridge version"))
        throw new Error("adbMissing");
      const devices = parseDevices(
        (await this.run(file, ["devices", "-l"], abort.signal)).toString(),
      );
      if (abort.signal.aborted || !this.authenticated())
        throw new Error("cancelled");
      return { devices, adbPath: file };
    } finally {
      this.pending.delete(abort);
    }
  }
  async enable(input: { adbPath: string; serial: string }) {
    this.stop();
    const epoch = this.epoch;
    const found = await this.discover(input.adbPath);
    if (epoch !== this.epoch || !this.authenticated())
      throw new Error("cancelled");
    if (
      !found.devices.some(
        (d) => d.serial === input.serial && d.state === "device",
      )
    )
      throw new Error("deviceOffline");
    this.device = new AdbDevice(found.adbPath, input.serial, this.run);
    this.changed();
    return this.status();
  }
  async call(owner: string, name: string, raw: unknown) {
    if (!this.authenticated() || !this.device || !this.owners.has(owner))
      throw new Error("notAuthorized");
    if (this.job) throw new Error("deviceBusy");
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("invalidArguments");
    const args = raw as Record<string, unknown>;
    const abort = new AbortController(),
      device = this.device,
      epoch = this.epoch;
    const job = { owner, abort };
    this.job = job;
    this.pending.add(abort);
    const valid = () => {
      if (
        abort.signal.aborted ||
        epoch !== this.epoch ||
        !this.authenticated() ||
        !this.owners.has(owner)
      )
        throw new Error("cancelled");
    };
    try {
      const keys =
        name === "android_screenshot"
          ? []
          : name === "android_tap"
            ? ["observationId", "x", "y"]
            : name === "android_swipe"
              ? ["observationId", "x", "y", "endX", "endY", "durationMs"]
              : name === "android_key"
                ? ["observationId", "key"]
                : name === "android_type_text"
                  ? ["observationId", "text"]
                  : null;
      if (!keys || Object.keys(args).some((k) => !keys.includes(k)))
        throw new Error("invalidArguments");
      await device.assertOnline(abort.signal);
      valid();
      if (name === "android_screenshot") {
        this.observations.delete(owner);
        const shot = await device.screenshot(abort.signal);
        valid();
        const observation = {
          id: randomUUID(),
          width: shot.width,
          height: shot.height,
          at: this.now(),
        };
        this.observations.set(owner, observation);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                observationId: observation.id,
                width: shot.width,
                height: shot.height,
              }),
            },
            {
              type: "image",
              mimeType: "image/png",
              data: shot.data.toString("base64"),
            },
          ],
        };
      }
      const observation = this.observations.get(owner);
      if (
        !observation ||
        args.observationId !== observation.id ||
        this.now() - observation.at > 30_000
      )
        throw new Error("observeAgain");
      const point = (key: string, limit: number) => {
        const value = args[key];
        if (
          !Number.isInteger(value) ||
          Number(value) < 0 ||
          Number(value) >= limit
        )
          throw new Error("invalidArguments");
        return String(value);
      };
      let words: string[];
      if (name === "android_tap")
        words = [
          "tap",
          point("x", observation.width),
          point("y", observation.height),
        ];
      else if (name === "android_swipe") {
        const duration = args.durationMs ?? 300;
        if (
          !Number.isInteger(duration) ||
          Number(duration) < 100 ||
          Number(duration) > 2000
        )
          throw new Error("invalidArguments");
        words = [
          "swipe",
          point("x", observation.width),
          point("y", observation.height),
          point("endX", observation.width),
          point("endY", observation.height),
          String(duration),
        ];
      } else if (name === "android_key") {
        if (!["BACK", "HOME", "APP_SWITCH"].includes(String(args.key)))
          throw new Error("invalidArguments");
        words = ["keyevent", "KEYCODE_" + args.key];
      } else {
        if (
          typeof args.text !== "string" ||
          !args.text.length ||
          args.text.length > 1000 ||
          /[^\x20-\x7e]|%s/.test(args.text)
        )
          throw new Error("asciiTextRequired");
        words = ["text", args.text.replace(/ /g, "%s")];
      }
      // 旋转后旧坐标不能投向新的画面；本地校验帧不送模，也不落盘。
      const current = await device.screenshot(abort.signal);
      valid();
      if (
        current.width !== observation.width ||
        current.height !== observation.height
      ) {
        this.observations.delete(owner);
        throw new Error("observeAgain");
      }
      if (this.now() - observation.at > 30_000) throw new Error("observeAgain");
      // 手机是共享的物理目标：任一会话写入后，其他会话的旧画面也不能继续使用。
      this.observations.clear();
      await device.input(words, abort.signal);
      valid();
      return {
        content: [
          {
            type: "text",
            text: "Action completed. Observe again before another action.",
          },
        ],
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "adbFailed";
      if (
        [
          "adbFailed",
          "adbMissing",
          "deviceOffline",
          "invalidScreenshot",
        ].includes(reason) &&
        epoch === this.epoch
      )
        this.stop(reason);
      throw error;
    } finally {
      this.pending.delete(abort);
      if (this.job === job) this.job = null;
    }
  }
}
