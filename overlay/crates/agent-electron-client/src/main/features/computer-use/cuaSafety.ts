import { createHash } from "node:crypto";
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
const SENSITIVE_LABEL = /删除|卸载|发送|付款|转账|授权|purchase|transfer|uninstall|empty.?trash|format|\b(?:send|delete|pay|authorize)\b/i;
const SAFE_ACTION_LABEL = /^(settings|preferences|cancel|back|设置|偏好设置|取消|返回|設定|偏好設定)$/i;
const DANGEROUS_HOTKEY = /shift.{0,12}delete|meta.{0,8}q|alt.{0,8}f4|ctrl.{0,12}shift.{0,12}delete/i;

export function isSensitiveCuaCall(tool: string, args: unknown): boolean {
  if (SENSITIVE_TOOLS.has(tool)) return true;
  const blob = JSON.stringify(args ?? "");
  if ((tool === "hotkey" || tool === "press_key") && DANGEROUS_HOTKEY.test(blob)) return true;
  // References/coordinates do not carry trusted labels. Unknown state-changing
  // input is sensitive until a recent host observation proves its target harmless.
  if (["click", "double_click", "right_click", "invoke_menu", "set_value", "browser_click", "browser_pointer",
    "type_text", "press_key", "hotkey", "drag", "browser_type", "browser_set_input_files", "browser_dialog"].includes(tool)) return true;
  if (SENSITIVE_LABEL.test(blob)) return true;
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


type Evidence = { digest: string; sensitive: boolean };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)).digest("hex");
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Stores hashes/flags only. Permissions are one-shot, per prompt owner and exact action. */
export class CuaConfirmationGate {
  private observations = new Map<string, { snapshot?: unknown; target: string; elements: Map<string, Evidence> }>();
  private pending = new Map<string, { key: string; until: number; allowed: boolean }>();
  constructor(private now: () => number = Date.now) {}
  observe(owner: string, tool: string, raw: unknown, structured: unknown) {
    if (!["get_window_state", "get_browser_state", "get_desktop_state"].includes(tool)) return;
    const args = object(raw), sc = object(structured);
    const elements = new Map<string, Evidence>(); let budget = 5000;
    const walk = (value: unknown) => {
      if (--budget < 0 || !value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(walk); return; }
      const element = object(value);
      const ref = element.element_index ?? element.index ?? element.ref;
      const label = [element.name, element.label, element.title, element.text, element.role].filter(v => typeof v === "string").join(" ");
      if ((typeof ref === "number" || typeof ref === "string") && label) elements.set(String(ref), {
        digest: hash([ref, label]), sensitive: SENSITIVE_LABEL.test(label) || !SAFE_ACTION_LABEL.test(
          [element.name, element.label, element.title, element.text].filter(v => typeof v === "string").join(" ").trim()),
      });
      for (const value of Object.values(element)) walk(value);
    };
    walk(sc);
    this.observations.set(owner, { snapshot: sc.snapshot_id, target: hash([args.pid, args.window_id, args.target_id, args.tab_id]), elements });
  }
  requires(owner: string, tool: string, raw: unknown): boolean {
    if (!isSensitiveCuaCall(tool, raw)) return false;
    const args = object(raw), observation = this.observations.get(owner);
    const ref = args.element_index ?? args.ref;
    const target = hash([args.pid, args.window_id, args.target_id, args.tab_id]);
    const evidence = observation && observation.target === target &&
      (observation.snapshot === undefined || observation.snapshot === args.snapshot_id)
      ? observation.elements.get(String(ref)) : undefined;
    const click = ["click", "double_click", "right_click", "browser_click"].includes(tool);
    if (click && evidence?.sensitive === false) return false;
    const { snapshot_id: _snapshot, element_token: _token, ...action } = args;
    const key = hash([tool, action, evidence?.digest]);
    const pending = this.pending.get(owner);
    if (pending?.allowed && pending.key === key && pending.until > this.now()) {
      this.pending.delete(owner); return false;
    }
    this.pending.set(owner, { key, until: this.now() + 60_000, allowed: false });
    return true;
  }
  allow(owner?: string): boolean {
    const key = owner ?? (this.pending.size === 1 ? this.pending.keys().next().value : undefined);
    const pending = key ? this.pending.get(key) : undefined;
    if (!pending || pending.until <= this.now()) return false;
    pending.allowed = true; return true;
  }
  retire(owner: string) { this.pending.delete(owner); this.observations.delete(owner); }
  clear() { this.pending.clear(); this.observations.clear(); }
}
