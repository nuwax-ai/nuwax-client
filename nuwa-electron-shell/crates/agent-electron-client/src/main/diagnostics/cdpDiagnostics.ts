// 商业版诊断通道：通过 userData 下 diagnostics.json 显式开启本机 CDP 调试端口。
//
// 策略（dev 与 packaged 运行形态完全一致，不因 isPackaged 常开）：
// - 默认关闭：文件缺失 / cdp.enabled 非 true 时，不开启任何调试端口；
// - 只认 diagnostics.json：外部命令行传入的 remote-debugging* / remote-allow-origins
//   开关一律先剥离，不存在“命令行绕过配置”的路径（也不提供 CLI 端口 opt-in，避免多开关优先级不清）；
// - fail closed：JSON 损坏、schemaVersion 不识别、字段类型错误、enabled=true 但 port
//   缺失/越界、host 非 127.0.0.1 —— 全部保持关闭并给出诊断信息，绝不静默回落默认端口；
// - 仅本机回环：host 只接受 127.0.0.1，永不设置 remote-allow-origins / 0.0.0.0 / 远端地址；
// - 本模块只读取配置文件，不写入、不创建 diagnostics.json（由用户按文档手工放置）；
// - 必须在 app.ready 之前调用（commandLine 开关仅 ready 前生效），配置改动下次启动生效。
// - 端口被占用时由 Chromium 自行记日志，应用照常运行，不杀进程、不换端口。
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const DIAGNOSTICS_CONFIG_FILE = "diagnostics.json";

/** CDP 只允许本机回环地址，其他取值一律 fail closed。 */
export const CDP_LOOPBACK_HOST = "127.0.0.1";

/** 允许的端口范围：避开 <1024 特权端口，上限 65535。 */
export const CDP_PORT_MIN = 1024;
export const CDP_PORT_MAX = 65535;

/** 外部（命令行/父进程）可能注入的 Chromium 调试开关，应用授权端口前一律剥离。 */
const UNAUTHORIZED_DEBUG_SWITCHES = [
  "remote-debugging-port",
  "remote-debugging-address",
  "remote-debugging-pipe",
  "remote-allow-origins",
] as const;

/** 与 Electron app.commandLine 同构的最小接口，便于单测注入假实现。 */
export interface CommandLineLike {
  appendSwitch(switchKey: string, value?: string): unknown;
  removeSwitch(switchKey: string): unknown;
}

/** diagnostics.json 中 cdp 段的合法形态（未知字段忽略，向前兼容）。 */
export interface DiagnosticsCdpSection {
  enabled?: boolean;
  port?: number;
  host?: string;
}

export type ParsedDiagnosticsConfig =
  | { ok: true; cdp: DiagnosticsCdpSection }
  | { ok: false; error: string };

export type CdpDecision =
  | {
      status: "off";
      reason: "no-config" | "cdp-disabled" | "invalid-config" | "read-error";
      detail?: string;
    }
  | { status: "on"; port: number; host: string };

export function parseDiagnosticsConfig(text: string): ParsedDiagnosticsConfig {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      error: `diagnostics.json 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, error: "diagnostics.json 顶层必须是 JSON 对象" };
  }
  const root = data as Record<string, unknown>;
  if (root.schemaVersion !== 1) {
    return {
      ok: false,
      error: `不支持的 schemaVersion=${JSON.stringify(
        root.schemaVersion,
      )}（仅支持 1）`,
    };
  }
  const cdpRaw = root.cdp;
  if (cdpRaw === undefined) return { ok: true, cdp: {} };
  if (typeof cdpRaw !== "object" || cdpRaw === null || Array.isArray(cdpRaw)) {
    return { ok: false, error: "cdp 字段必须是对象" };
  }
  const { enabled, port, host } = cdpRaw as Record<string, unknown>;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return {
      ok: false,
      error: `cdp.enabled 必须是 boolean，实际为 ${JSON.stringify(enabled)}`,
    };
  }
  if (
    port !== undefined &&
    (typeof port !== "number" || !Number.isInteger(port))
  ) {
    return {
      ok: false,
      error: `cdp.port 必须是整数，实际为 ${JSON.stringify(port)}`,
    };
  }
  if (host !== undefined && typeof host !== "string") {
    return {
      ok: false,
      error: `cdp.host 必须是字符串，实际为 ${JSON.stringify(host)}`,
    };
  }
  return { ok: true, cdp: { enabled, port, host } };
}

export function evaluateCdp(parsed: ParsedDiagnosticsConfig): CdpDecision {
  if (!parsed.ok) {
    return { status: "off", reason: "invalid-config", detail: parsed.error };
  }
  if (parsed.cdp.enabled !== true) {
    return { status: "off", reason: "cdp-disabled" };
  }
  const port = parsed.cdp.port;
  if (port === undefined || port < CDP_PORT_MIN || port > CDP_PORT_MAX) {
    // enabled=true 但端口缺失/越界：fail closed，绝不静默回落默认端口。
    return {
      status: "off",
      reason: "invalid-config",
      detail: `cdp.enabled=true 需要配套 cdp.port=${CDP_PORT_MIN}-${CDP_PORT_MAX} 的整数端口，实际为 ${JSON.stringify(
        parsed.cdp.port,
      )}`,
    };
  }
  const host = parsed.cdp.host ?? CDP_LOOPBACK_HOST;
  if (host !== CDP_LOOPBACK_HOST) {
    return {
      status: "off",
      reason: "invalid-config",
      detail: `cdp.host 仅接受 "${CDP_LOOPBACK_HOST}"，实际为 ${JSON.stringify(
        host,
      )}`,
    };
  }
  return { status: "on", port, host };
}

/** 无论决策结果如何，先剥离外部注入的调试开关，再按决策追加唯一授权的回环端口。 */
export function applyCdpSwitches(
  commandLine: CommandLineLike,
  decision: CdpDecision,
): void {
  for (const key of UNAUTHORIZED_DEBUG_SWITCHES) {
    commandLine.removeSwitch(key);
  }
  if (decision.status === "on") {
    commandLine.appendSwitch("remote-debugging-port", String(decision.port));
    commandLine.appendSwitch("remote-debugging-address", decision.host);
  }
}

export interface CdpDiagnosticsDeps {
  userDir: string;
  commandLine: CommandLineLike;
  readFile?: (path: string) => string;
  joinPath?: (dir: string, file: string) => string;
}

/**
 * 读取 userDir 下 diagnostics.json → 决策 → 应用到 Chromium 命令行。
 * 只读不写；任何异常输入都收敛为 fail-closed 决策，不抛出。
 */
export function configureCdpDiagnostics(deps: CdpDiagnosticsDeps): CdpDecision {
  const readFile =
    deps.readFile ?? ((p: string) => readFileSync(p, "utf8") as string);
  const joinPath = deps.joinPath ?? ((dir: string, file: string) => join(dir, file));
  const file = joinPath(deps.userDir, DIAGNOSTICS_CONFIG_FILE);

  let text: string | null = null;
  let readError: string | null = null;
  try {
    text = readFile(file);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      text = null;
    } else {
      const message = e instanceof Error ? e.message : String(e);
      readError = `读取 ${DIAGNOSTICS_CONFIG_FILE} 失败${code ? `（${code}）` : ""}：${message}`;
    }
  }

  let decision: CdpDecision;
  if (readError !== null) {
    decision = { status: "off", reason: "read-error", detail: readError };
  } else if (text === null) {
    decision = { status: "off", reason: "no-config" };
  } else {
    decision = evaluateCdp(parseDiagnosticsConfig(text));
  }
  applyCdpSwitches(deps.commandLine, decision);
  return decision;
}

export interface CdpDecisionLog {
  level: "info" | "warn" | "silent";
  message: string;
}

/**
 * 供主进程在 initLogging 之后输出：开启=info 明示（日志里可见“调试中”），
 * 坏配置/读取失败=warn 诊断，默认关闭态不刷屏。
 */
export function describeCdpDecision(decision: CdpDecision): CdpDecisionLog {
  if (decision.status === "on") {
    return {
      level: "info",
      message: `[Diagnostics] CDP 调试已开启：http://${decision.host}:${decision.port} （diagnostics.json 显式开启，仅本机回环；用毕请置 false 并重启）`,
    };
  }
  if (decision.reason === "invalid-config" || decision.reason === "read-error") {
    return {
      level: "warn",
      message: `[Diagnostics] CDP 保持关闭（fail closed）：${decision.detail ?? decision.reason}`,
    };
  }
  return { level: "silent", message: "" };
}
