import { describe, it, expect, vi } from "vitest";
import { AndroidController } from "./controller";
import { parseDevices, resolveAdbPath, type AdbRun } from "./adb";

function png(width = 1080, height = 2400) {
  const data = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data);
  data.write("IHDR", 12);
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}
function fixture() {
  let authenticated = true,
    clock = 1;
  const run = vi.fn<AdbRun>(async (_file, args) =>
    args[0] === "version"
      ? Buffer.from("Android Debug Bridge version 1.0.41")
      : args[0] === "devices"
        ? Buffer.from(
            "List of devices attached\na device model:Pixel_9 transport_id:1\nb unauthorized\nc offline\n",
          )
        : args.includes("get-state")
          ? Buffer.from("device\n")
          : args.includes("screencap")
            ? png()
            : Buffer.alloc(0),
  );
  const changed = vi.fn();
  const controller = new AndroidController(
    () => authenticated,
    changed,
    run,
    () => clock,
  );
  const enable = async () => {
    await controller.enable({ adbPath: "adb", serial: "a" });
    controller.start("owner");
  };
  const observe = async (owner = "owner") =>
    JSON.parse(
      (await controller.call(owner, "android_screenshot", {})).content[0].text!,
    );
  return {
    run,
    controller,
    enable,
    observe,
    auth: (value: boolean) => (authenticated = value),
    time: (value: number) => (clock = value),
  };
}
describe("Android 手机控制边界", () => {
  it("保留多设备状态，不自动选择，拒绝不安全路径与序列号", async () => {
    expect(
      parseDevices(
        "List of devices attached\na device model:Pixel_9\nb unauthorized\nc offline\n",
      ),
    ).toEqual([
      { serial: "a", state: "device", model: "Pixel 9" },
      { serial: "b", state: "unauthorized", model: "b" },
      { serial: "c", state: "offline", model: "c" },
    ]);
    expect(() => resolveAdbPath("./adb")).toThrow("invalidPath");
    const f = fixture();
    expect(f.controller.status().enabled).toBe(false);
    await expect(
      f.controller.enable({ adbPath: "adb", serial: "b" }),
    ).rejects.toThrow("deviceOffline");
    await expect(
      f.controller.enable({ adbPath: "adb", serial: "-s another" }),
    ).rejects.toThrow("deviceOffline");
  });
  it("未登录、未授权、非活动会话不运行手机命令", async () => {
    const f = fixture();
    f.auth(false);
    await expect(f.enable()).rejects.toThrow("loginRequired");
    expect(f.run).not.toHaveBeenCalled();
    f.auth(true);
    await f.enable();
    f.run.mockClear();
    await expect(
      f.controller.call("other", "android_screenshot", {}),
    ).rejects.toThrow("notAuthorized");
    expect(f.run).not.toHaveBeenCalled();
  });
  it("所有手机命令绑定选定序列号，截图只在内存返回", async () => {
    const f = fixture();
    await f.enable();
    f.run.mockClear();
    const result = await f.controller.call("owner", "android_screenshot", {});
    expect(result.content[1]).toMatchObject({
      type: "image",
      mimeType: "image/png",
    });
    expect(
      f.run.mock.calls.every(([, args]) => args[0] === "-s" && args[1] === "a"),
    ).toBe(true);
  });
  it("写操作只接受当前会话最近截图，操作后必须重新观察", async () => {
    const f = fixture();
    await f.enable();
    const shot = await f.observe();
    f.controller.start("other");
    await expect(
      f.controller.call("other", "android_tap", {
        observationId: shot.observationId,
        x: 0,
        y: 0,
      }),
    ).rejects.toThrow("observeAgain");
    await f.controller.call("owner", "android_tap", {
      observationId: shot.observationId,
      x: 10,
      y: 20,
    });
    expect(f.run.mock.calls.at(-1)?.[1]).toEqual([
      "-s",
      "a",
      "shell",
      "'input'",
      "'tap'",
      "'10'",
      "'20'",
    ]);
    await expect(
      f.controller.call("owner", "android_tap", {
        observationId: shot.observationId,
        x: 10,
        y: 20,
      }),
    ).rejects.toThrow("observeAgain");
  });
  it("拒绝过期、旋转和越界观察，不发送写命令", async () => {
    const f = fixture();
    await f.enable();
    let shot = await f.observe();
    f.time(30_002);
    await expect(
      f.controller.call("owner", "android_tap", {
        observationId: shot.observationId,
        x: 0,
        y: 0,
      }),
    ).rejects.toThrow("observeAgain");
    shot = await f.observe();
    await expect(
      f.controller.call("owner", "android_tap", {
        observationId: shot.observationId,
        x: 1080,
        y: 0,
      }),
    ).rejects.toThrow("invalidArguments");
    f.run.mockImplementation(async (_file, args) =>
      args.includes("get-state") ? Buffer.from("device") : png(2400, 1080),
    );
    await expect(
      f.controller.call("owner", "android_tap", {
        observationId: shot.observationId,
        x: 0,
        y: 0,
      }),
    ).rejects.toThrow("observeAgain");
    expect(f.run.mock.calls.some(([, args]) => args.includes("shell"))).toBe(
      false,
    );
  });
  it("任一会话操作手机后，其他会话也必须重新观察", async () => {
    const f = fixture();
    await f.enable();
    f.controller.start("other");
    const a = await f.observe(),
      b = await f.observe("other");
    await f.controller.call("owner", "android_tap", {
      observationId: a.observationId,
      x: 0,
      y: 0,
    });
    await expect(
      f.controller.call("other", "android_tap", {
        observationId: b.observationId,
        x: 0,
        y: 0,
      }),
    ).rejects.toThrow("observeAgain");
    expect(
      f.run.mock.calls.filter(([, args]) => args.includes("shell")),
    ).toHaveLength(1);
  });
  it("转义远端 shell 文本，限制按键及输入范围", async () => {
    const f = fixture();
    await f.enable();
    let shot = await f.observe();
    const text = "a '$(id);`id` b";
    await f.controller.call("owner", "android_type_text", {
      observationId: shot.observationId,
      text,
    });
    expect(f.run.mock.calls.at(-1)?.[1]).toEqual([
      "-s",
      "a",
      "shell",
      "'input'",
      "'text'",
      "'a%s'\\''$(id);`id`%sb'",
    ]);
    shot = await f.observe();
    await expect(
      f.controller.call("owner", "android_type_text", {
        observationId: shot.observationId,
        text: "中文",
      }),
    ).rejects.toThrow("asciiTextRequired");
    await expect(
      f.controller.call("owner", "android_key", {
        observationId: shot.observationId,
        key: "ENTER",
      }),
    ).rejects.toThrow("invalidArguments");
    await expect(
      f.controller.call("owner", "android_tap", {
        observationId: shot.observationId,
        x: 0,
        y: 0,
        serial: "b",
      }),
    ).rejects.toThrow("invalidArguments");
  });
  it("断线停止控制，不重试可能已生效的写动作", async () => {
    const f = fixture();
    await f.enable();
    const shot = await f.observe();
    f.run.mockImplementation(async (_file, args) => {
      if (args.includes("shell")) throw new Error("adbFailed");
      return args.includes("get-state") ? Buffer.from("device") : png();
    });
    await expect(
      f.controller.call("owner", "android_tap", {
        observationId: shot.observationId,
        x: 0,
        y: 0,
      }),
    ).rejects.toThrow("adbFailed");
    expect(
      f.run.mock.calls.filter(([, args]) => args.includes("shell")),
    ).toHaveLength(1);
    expect(f.controller.status()).toMatchObject({
      enabled: false,
      serial: null,
      error: "adbFailed",
    });
  });
  it("在途截图单飞，停止时中断进程并丢弃迟到图像", async () => {
    const f = fixture();
    await f.enable();
    let release!: (value: Buffer) => void, signal!: AbortSignal;
    f.run.mockImplementation(async (_file, args, input) =>
      args.includes("get-state")
        ? Buffer.from("device")
        : new Promise<Buffer>((resolve) => {
            signal = input;
            release = resolve;
          }),
    );
    const pending = f.controller.call("owner", "android_screenshot", {});
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await expect(
      f.controller.call("owner", "android_screenshot", {}),
    ).rejects.toThrow("deviceBusy");
    f.controller.stop();
    expect(signal.aborted).toBe(true);
    release(png());
    await expect(pending).rejects.toThrow("cancelled");
    expect(f.controller.status().enabled).toBe(false);
  });
  it("取消会话后，即使另一轮启动也不能接受旧的在途回包", async () => {
    const f = fixture();
    await f.enable();
    let release!: (value: Buffer) => void;
    f.run.mockImplementation(async (_file, args) =>
      args.includes("get-state")
        ? Buffer.from("device")
        : new Promise<Buffer>((resolve) => (release = resolve)),
    );
    const pending = f.controller.call("owner", "android_screenshot", {});
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    f.controller.cancel("owner");
    f.controller.start("owner");
    release(png());
    await expect(pending).rejects.toThrow("cancelled");
  });
});
