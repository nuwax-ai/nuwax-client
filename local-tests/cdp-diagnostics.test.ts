// cdpDiagnostics 局部单测：node --experimental-strip-types --test local-tests/cdp-diagnostics.test.ts
// 纯逻辑 + 临时文件验证，不拉起 Electron、不跑基座 overlay 测试、不触碰真实用户目录。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configureCdpDiagnostics,
  parseDiagnosticsConfig,
  evaluateCdp,
  applyCdpSwitches,
  describeCdpDecision,
  DIAGNOSTICS_CONFIG_FILE,
  type CommandLineLike,
  type CdpDecision,
} from "../overlay/crates/agent-electron-client/src/main/diagnostics/cdpDiagnostics.ts";

/** 模拟 Electron app.commandLine：由 argv 预置开关，记录 append/remove 终态。 */
class FakeCommandLine implements CommandLineLike {
  readonly switches = new Map<string, string | true>();
  constructor(argv: string[] = []) {
    for (const arg of argv) {
      if (!arg.startsWith("--")) continue;
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq === -1) this.switches.set(body, true);
      else this.switches.set(body.slice(0, eq), body.slice(eq + 1));
    }
  }
  appendSwitch(key: string, value?: string): void {
    this.switches.set(key, value ?? true);
  }
  removeSwitch(key: string): void {
    this.switches.delete(key);
  }
  get(key: string): string | true | undefined {
    return this.switches.get(key);
  }
}

const asOn = (d: CdpDecision) => {
  assert.equal(d.status, "on");
  return d;
};
const asOff = (d: CdpDecision) => {
  assert.equal(d.status, "off");
  return d;
};

test("文件缺失：默认关闭，且不追加任何调试开关", () => {
  const cl = new FakeCommandLine();
  const decision = configureCdpDiagnostics({
    userDir: "/nonexistent-user-dir",
    commandLine: cl,
    readFile: () => {
      const e = new Error("not found") as NodeJS.ErrnoException;
      e.code = "ENOENT";
      throw e;
    },
  });
  assert.equal(asOff(decision).reason, "no-config");
  assert.equal(cl.switches.size, 0);
});

test("显式开启：enabled=true + 合法端口 → 追加 127.0.0.1 授权端口", () => {
  const cl = new FakeCommandLine();
  const decision = configureCdpDiagnostics({
    userDir: "/u",
    commandLine: cl,
    readFile: () =>
      JSON.stringify({ schemaVersion: 1, cdp: { enabled: true, port: 9222 } }),
  });
  const on = asOn(decision);
  assert.equal(on.port, 9222);
  assert.equal(on.host, "127.0.0.1");
  assert.equal(cl.get("remote-debugging-port"), "9222");
  assert.equal(cl.get("remote-debugging-address"), "127.0.0.1");
});

test("enabled=false / cdp 段缺失：保持关闭", () => {
  for (const text of [
    JSON.stringify({ schemaVersion: 1, cdp: { enabled: false, port: 9222 } }),
    JSON.stringify({ schemaVersion: 1 }),
  ]) {
    const cl = new FakeCommandLine();
    const decision = configureCdpDiagnostics({
      userDir: "/u",
      commandLine: cl,
      readFile: () => text,
    });
    assert.equal(asOff(decision).reason, "cdp-disabled");
    assert.equal(cl.switches.size, 0);
  }
});

test("端口边界：1024/65535 放行；1023/65536/0/缺失/非整数 fail closed（不回落默认端口）", () => {
  for (const port of [1024, 65535]) {
    const on = asOn(
      evaluateCdp(parseDiagnosticsConfig(
        JSON.stringify({ schemaVersion: 1, cdp: { enabled: true, port } }),
      )),
    );
    assert.equal(on.port, port);
  }
  for (const port of [1023, 65536, 0, undefined, 9222.5]) {
    const cdp: Record<string, unknown> = { enabled: true };
    if (port !== undefined) cdp.port = port;
    const off = asOff(evaluateCdp(parseDiagnosticsConfig(
      JSON.stringify({ schemaVersion: 1, cdp }),
    )));
    assert.equal(off.reason, "invalid-config");
    assert.ok(off.detail?.includes("CDP") || off.detail?.includes("port") || off.detail !== undefined);
  }
});

test("loopback 约束：仅 127.0.0.1（或缺省）放行；0.0.0.0/localhost/::1/远端地址 fail closed", () => {
  for (const host of ["127.0.0.1", undefined]) {
    const cdp: Record<string, unknown> = { enabled: true, port: 9222 };
    if (host !== undefined) cdp.host = host;
    const on = asOn(evaluateCdp(parseDiagnosticsConfig(
      JSON.stringify({ schemaVersion: 1, cdp }),
    )));
    assert.equal(on.host, "127.0.0.1");
  }
  for (const host of ["0.0.0.0", "localhost", "::1", "192.168.1.5", "example.com"]) {
    const off = asOff(evaluateCdp(parseDiagnosticsConfig(
      JSON.stringify({ schemaVersion: 1, cdp: { enabled: true, port: 9222, host } }),
    )));
    assert.equal(off.reason, "invalid-config");
    assert.ok(off.detail?.includes("127.0.0.1"));
  }
});

test("坏 JSON / 顶层非对象：fail closed 并给出诊断", () => {
  for (const text of ["{oops", "[]", '"string"']) {
    const off = asOff(evaluateCdp(parseDiagnosticsConfig(text)));
    assert.equal(off.reason, "invalid-config");
    assert.ok(off.detail && off.detail.length > 0);
  }
});

test("坏类型：enabled/port/host 类型不对 → fail closed", () => {
  for (const cdp of [
    { enabled: "true", port: 9222 },
    { enabled: true, port: "9222" },
    { enabled: true, port: 9222, host: 127 },
  ]) {
    const parsed = parseDiagnosticsConfig(
      JSON.stringify({ schemaVersion: 1, cdp }),
    );
    assert.equal(parsed.ok, false, JSON.stringify(cdp));
    assert.equal(asOff(evaluateCdp(parsed)).reason, "invalid-config");
  }
});

test("未知 schemaVersion / schemaVersion 缺失：fail closed", () => {
  for (const text of [
    JSON.stringify({ schemaVersion: 2, cdp: { enabled: true, port: 9222 } }),
    JSON.stringify({ cdp: { enabled: true, port: 9222 } }),
  ]) {
    const parsed = parseDiagnosticsConfig(text);
    assert.equal(parsed.ok, false);
    assert.equal(asOff(evaluateCdp(parsed)).reason, "invalid-config");
  }
});

test("未知 cdp 字段忽略（向前兼容），不影响开启", () => {
  const on = asOn(evaluateCdp(parseDiagnosticsConfig(
    JSON.stringify({ schemaVersion: 1, cdp: { enabled: true, port: 9222, future: "x" } }),
  )));
  assert.equal(on.port, 9222);
});

test("恶意/外部命令行不绕过：配置关闭时 remote-debugging* 全部被剥离", () => {
  const cl = new FakeCommandLine([
    "--remote-debugging-port=1337",
    "--remote-debugging-address=0.0.0.0",
    "--remote-allow-origins=*",
    "--remote-debugging-pipe",
  ]);
  const decision = configureCdpDiagnostics({
    userDir: "/u",
    commandLine: cl,
    readFile: () => {
      const e = new Error("not found") as NodeJS.ErrnoException;
      e.code = "ENOENT";
      throw e;
    },
  });
  assert.equal(asOff(decision).reason, "no-config");
  assert.equal(cl.switches.size, 0);
});

test("外部命令行不覆盖授权端口：开启 9222 时外部 1337/origins 被剥离，只留 9222", () => {
  const cl = new FakeCommandLine(["--remote-debugging-port=1337", "--remote-allow-origins=*"]);
  configureCdpDiagnostics({
    userDir: "/u",
    commandLine: cl,
    readFile: () =>
      JSON.stringify({ schemaVersion: 1, cdp: { enabled: true, port: 9222 } }),
  });
  assert.equal(cl.get("remote-debugging-port"), "9222");
  assert.equal(cl.get("remote-debugging-address"), "127.0.0.1");
  assert.equal(cl.get("remote-allow-origins"), undefined);
  assert.equal(cl.switches.size, 2);
});

test("dev 与 packaged 行为一致：同一输入两次决策与命令行终态完全相同（无 isPackaged 分支）", () => {
  const text = JSON.stringify({ schemaVersion: 1, cdp: { enabled: true, port: 9333 } });
  const results = [false, true].map(() => {
    const cl = new FakeCommandLine();
    const decision = configureCdpDiagnostics({
      userDir: "/u",
      commandLine: cl,
      readFile: () => text,
    });
    return { decision, switches: [...cl.switches.entries()] };
  });
  assert.deepEqual(results[0], results[1]);
});

test("只读不写：运行后配置文件内容不变，且全程无写调用", () => {
  const original = JSON.stringify({ schemaVersion: 1, cdp: { enabled: true, port: 9222 } });
  const writes: string[] = [];
  const cl = new FakeCommandLine();
  const decision = configureCdpDiagnostics({
    userDir: "/u",
    commandLine: cl,
    readFile: () => original,
    joinPath: (dir, file) => {
      writes.push(`join:${dir}/${file}`);
      return `${dir}/${file}`;
    },
  });
  assert.equal(asOn(decision).port, 9222);
  assert.equal(original, JSON.stringify({ schemaVersion: 1, cdp: { enabled: true, port: 9222 } }));
  assert.ok(writes.every((w) => w.startsWith("join:")), "不应出现任何写文件调用");
});

test("真实临时文件：默认 fs 路径读取 diagnostics.json（默认关→开启）", () => {
  const dir = mkdtempSync(join(tmpdir(), "nuwax-cdp-"));
  try {
    const clOff = new FakeCommandLine();
    assert.equal(
      asOff(configureCdpDiagnostics({ userDir: dir, commandLine: clOff })).reason,
      "no-config",
    );
    writeFileSync(
      join(dir, DIAGNOSTICS_CONFIG_FILE),
      JSON.stringify({ schemaVersion: 1, cdp: { enabled: true, port: 9222, host: "127.0.0.1" } }),
    );
    const clOn = new FakeCommandLine();
    assert.equal(
      asOn(configureCdpDiagnostics({ userDir: dir, commandLine: clOn })).port,
      9222,
    );
    assert.equal(clOn.get("remote-debugging-port"), "9222");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("读取失败（非 ENOENT）：fail closed 并诊断", () => {
  const cl = new FakeCommandLine();
  const decision = configureCdpDiagnostics({
    userDir: "/u",
    commandLine: cl,
    readFile: () => {
      const e = new Error("permission denied") as NodeJS.ErrnoException;
      e.code = "EACCES";
      throw e;
    },
  });
  assert.equal(asOff(decision).reason, "read-error");
  assert.equal(cl.switches.size, 0);
});

test("日志分级：开启=info（含 host:port），坏配置=warn，默认态=silent", () => {
  const info = describeCdpDecision({ status: "on", port: 9222, host: "127.0.0.1" });
  assert.equal(info.level, "info");
  assert.ok(info.message.includes("127.0.0.1:9222"));
  assert.equal(
    describeCdpDecision({ status: "off", reason: "invalid-config", detail: "bad" }).level,
    "warn",
  );
  assert.equal(describeCdpDecision({ status: "off", reason: "no-config" }).level, "silent");
  assert.equal(describeCdpDecision({ status: "off", reason: "cdp-disabled" }).level, "silent");
});

test("applyCdpSwitches 可独立重放（决策→命令行映射稳定）", () => {
  const cl = new FakeCommandLine(["--remote-debugging-port=1"]);
  applyCdpSwitches(cl, { status: "on", port: 9222, host: "127.0.0.1" });
  assert.deepEqual([...cl.switches.entries()], [
    ["remote-debugging-port", "9222"],
    ["remote-debugging-address", "127.0.0.1"],
  ]);
});
