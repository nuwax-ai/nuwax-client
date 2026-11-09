#!/usr/bin/env node
// 只读真机验收：显式指定设备，仅验证真实 ADB 截图与停止，不输出或保存屏幕内容。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, "../..");
const client = path.join(
  root,
  "nuwa-electron-shell/crates/agent-electron-client",
);
const requireClient = createRequire(path.join(client, "package.json"));

async function main() {
  const args = process.argv.slice(2);
  const get = (key) => {
    const index = args.indexOf(key);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const serial = get("--serial");
  if (!serial)
    throw new Error(
      "Usage: node scripts/acceptance/android-device.cjs --serial <authorized-device> [--adb <absolute-path>]",
    );
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "nuwax-android-acceptance-"),
  );
  let controller;
  try {
    await requireClient("esbuild").build({
      entryPoints: [
        path.join(client, "src/main/features/android/controller.ts"),
      ],
      outfile: path.join(temporary, "controller.cjs"),
      platform: "node",
      format: "cjs",
      bundle: true,
    });
    const { AndroidController } = require(
      path.join(temporary, "controller.cjs"),
    );
    // 本层只验 ADB 适配；受信宿主、登录及 Agent 权限由特性集成测试另行覆盖。
    controller = new AndroidController(
      () => true,
      () => undefined,
    );
    await controller.enable({ serial, adbPath: get("--adb") ?? "adb" });
    controller.start("acceptance");
    const result = await controller.call(
      "acceptance",
      "android_screenshot",
      {},
    );
    const dimensions = JSON.parse(result.content[0].text);
    const bytes = Buffer.from(result.content[1].data, "base64").length;
    controller.stop();
    let revoked = false;
    try {
      await controller.call("acceptance", "android_screenshot", {});
    } catch (error) {
      revoked = error.message === "notAuthorized";
    }
    if (!revoked) throw new Error("Stop did not revoke control");
    console.log(
      JSON.stringify({
        width: dimensions.width,
        height: dimensions.height,
        pngBytes: bytes,
        stopRevoked: revoked,
        physicalInputTested: false,
      }),
    );
  } finally {
    controller?.stop();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
