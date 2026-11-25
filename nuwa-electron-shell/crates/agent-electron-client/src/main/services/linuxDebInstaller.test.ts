import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "events";
import {
  installLinuxDeb,
  DEB_INSTALL_SCRIPT,
  type LinuxDebInstallerDeps,
} from "./linuxDebInstaller";

interface SpawnCall {
  cmd: string;
  args: string[];
  options: any;
}

/** exitCodes 依次作为每次 spawn 的退出码；用 undefined 表示进程无法启动。 */
function makeDeps(
  exitCodes: Array<number | undefined>,
  overrides: Partial<LinuxDebInstallerDeps> = {},
) {
  const calls: SpawnCall[] = [];
  const closeLog = vi.fn();
  const deps: LinuxDebInstallerDeps = {
    spawn: ((cmd: string, args: string[], options: any) => {
      calls.push({ cmd, args, options });
      const child = new EventEmitter() as any;
      const code = exitCodes.shift();
      setImmediate(() => {
        if (code === undefined) child.emit("error", new Error("spawn ENOENT"));
        else child.emit("exit", code);
      });
      return child;
    }) as any,
    findCommand: (name) => (name === "pkexec" ? "/usr/bin/pkexec" : null),
    isRoot: () => false,
    openLog: vi.fn(() => 42),
    closeLog,
    ...overrides,
  };
  return { deps, calls, closeLog };
}

const baseOptions = () => ({
  debPath: "/home/u/.cache/nuwax-updater/pending/Nuwax-3.0.14-beta.6-amd64.deb",
  logPath: "/home/u/.nuwax/logs/update-install.log",
});

describe("installLinuxDeb", () => {
  it("经 pkexec 执行一次安装脚本，输出写日志文件", async () => {
    const { deps, calls, closeLog } = makeDeps([0]);

    const result = await installLinuxDeb(baseOptions(), deps);

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("/usr/bin/pkexec");
    expect(calls[0].args).toEqual([
      "/bin/sh",
      "-c",
      DEB_INSTALL_SCRIPT,
      "nuwax-update",
      baseOptions().debPath,
    ]);
    // 输出落日志文件，不接管道：壳在安装中途退出时 dpkg 不会因 SIGPIPE 中止
    expect(calls[0].options.stdio).toEqual(["ignore", 42, 42]);
    expect(closeLog).toHaveBeenCalledWith(42);
  });

  it("用户在系统授权框点了取消（126），归为授权未通过", async () => {
    const { deps, closeLog } = makeDeps([126]);

    const result = await installLinuxDeb(baseOptions(), deps);

    expect(result).toEqual({ ok: false, reason: "auth-failed" });
    expect(closeLog).toHaveBeenCalledWith(42);
  });

  it("拿不到授权（127，例如桌面上没有授权代理），归为无法在客户端内安装", async () => {
    const { deps } = makeDeps([127]);

    const result = await installLinuxDeb(baseOptions(), deps);

    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("dpkg 非零退出返回 install-failed，日志照常关闭", async () => {
    const { deps, closeLog } = makeDeps([1]);

    const result = await installLinuxDeb(baseOptions(), deps);

    expect(result).toEqual({ ok: false, reason: "install-failed" });
    expect(closeLog).toHaveBeenCalledWith(42);
  });

  it("没有 pkexec 时不启动任何进程", async () => {
    const { deps, calls } = makeDeps([], { findCommand: () => null });

    const result = await installLinuxDeb(baseOptions(), deps);

    expect(result).toEqual({ ok: false, reason: "unavailable" });
    expect(calls).toHaveLength(0);
    expect(deps.openLog).not.toHaveBeenCalled();
  });

  it("pkexec 进程无法启动，按无法在客户端内安装处理", async () => {
    const { deps, closeLog } = makeDeps([undefined]);

    const result = await installLinuxDeb(baseOptions(), deps);

    expect(result).toEqual({ ok: false, reason: "unavailable" });
    expect(closeLog).toHaveBeenCalledWith(42);
  });

  it("以 root 运行时跳过 pkexec，直接执行安装脚本", async () => {
    const { deps, calls } = makeDeps([0], {
      isRoot: () => true,
      findCommand: () => null,
    });

    const result = await installLinuxDeb(baseOptions(), deps);

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("/bin/sh");
    expect(calls[0].args).toEqual([
      "-c",
      DEB_INSTALL_SCRIPT,
      "nuwax-update",
      baseOptions().debPath,
    ]);
  });

  it("root 直装时脚本自己的 126 / 127 不会被当成授权问题", async () => {
    const root = (code: number) => makeDeps([code], { isRoot: () => true }).deps;

    expect(await installLinuxDeb(baseOptions(), root(126))).toEqual({ ok: false, reason: "install-failed" });
    expect(await installLinuxDeb(baseOptions(), root(127))).toEqual({ ok: false, reason: "install-failed" });
  });

  it("安装脚本 dpkg 失败时补跑 apt-get 修依赖，并以非交互模式运行", () => {
    expect(DEB_INSTALL_SCRIPT).toContain('dpkg -i "$1"');
    expect(DEB_INSTALL_SCRIPT).toContain("apt-get install -f -y");
    expect(DEB_INSTALL_SCRIPT).toContain("DEBIAN_FRONTEND=noninteractive");
  });
});
