/** 授权模式、敏感动作与黑名单比对（最终方案第 4–5、8 节）。 */

export type CuaAuthMode = "ask" | "unrestricted";

export function readCuaAuthMode(raw: unknown): CuaAuthMode {
  return raw === "ask" ? "ask" : "unrestricted";
}

export function readCuaBlacklist(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((item) => String(item ?? "").trim()).filter(Boolean))].slice(0, 80);
}

export function normalizeAppId(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\.app$/i, "");
}

export function matchesCuaBlacklist(
  haystacks: Array<string | undefined | null>,
  blacklist: readonly string[],
): boolean {
  const needles = blacklist.map(normalizeAppId).filter(Boolean);
  if (!needles.length) return false;
  return haystacks.some((item) => {
    if (!item) return false;
    const hay = normalizeAppId(String(item));
    return needles.some((needle) => hay === needle || hay.includes(needle) || needle.includes(hay));
  });
}

const SENSITIVE_TOOLS = new Set(["kill_app", "clipboard_write"]);
const SENSITIVE_LABEL = /删除|卸载|发送|付款|转账|授权|purchase|transfer|uninstall|empty.?trash|format/i;
const DANGEROUS_HOTKEY = /shift.{0,12}delete|meta.{0,8}q|alt.{0,8}f4|ctrl.{0,12}shift.{0,12}delete/i;

export function isSensitiveCuaCall(tool: string, args: unknown): boolean {
  if (SENSITIVE_TOOLS.has(tool)) return true;
  const blob = JSON.stringify(args ?? "");
  if ((tool === "hotkey" || tool === "press_key") && DANGEROUS_HOTKEY.test(blob)) return true;
  if (["click", "invoke_menu", "set_value", "browser_click"].includes(tool) && SENSITIVE_LABEL.test(blob)) return true;
  return false;
}

export function callIdentity(args: unknown): { pid?: number; app?: string; title?: string } {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  const value = args as Record<string, unknown>;
  return {
    pid: typeof value.pid === "number" ? value.pid : undefined,
    app: typeof value.app_name === "string" ? value.app_name
      : typeof value.app === "string" ? value.app : undefined,
    title: typeof value.title === "string" ? value.title : undefined,
  };
}
