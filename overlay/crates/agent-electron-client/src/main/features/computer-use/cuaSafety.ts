import { createHash } from "node:crypto";
/** 授权模式、敏感动作与黑名单比对（最终方案第 4–5、8 节）。 */

export type CuaAuthMode = "ask" | "unrestricted";

/** 会授予系统特权或锁屏身份的宿主，用户名单之外也一律跳过。 */
export const CUA_BUILTIN_SENSITIVE_APPS = ["SecurityAgent", "loginwindow"] as const;

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

/** 用户黑名单 + 内置特权/锁屏应用。 */
export function isDeniedCuaApp(
  haystacks: Array<string | undefined | null>,
  userBlacklist: readonly string[] = [],
): boolean {
  return matchesCuaBlacklist(haystacks, [...CUA_BUILTIN_SENSITIVE_APPS, ...userBlacklist]);
}

const SENSITIVE_TOOLS = new Set(["kill_app", "clipboard_write"]);
const SENSITIVE_LABEL = /删除|卸载|发送|付款|转账|授权|purchase|transfer|uninstall|empty.?trash|format|\b(?:send|delete|pay|authorize)\b/i;
const SAFE_ACTION_LABEL = /^(settings|preferences|cancel|back|设置|偏好设置|取消|返回|設定|偏好設定)$/i;
const DANGEROUS_HOTKEY = /shift.{0,12}delete|meta.{0,8}q|alt.{0,8}f4|ctrl.{0,12}shift.{0,12}delete/i;
const WRITE_TOOLS = new Set(["click", "double_click", "right_click", "set_value", "scroll", "invoke_menu", "browser_click"]);

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

/** 密码栏 / 卡号栏 / 系统授权对话框：无产品允许路径，一律硬拒。付款按钮仍走 ask 确认。 */
const SECURE_ROLE = /AXSecureTextField|securetextfield|secure.?text.?field|password.?field/i;
const FIELD_ROLE = /AXTextField|AXComboBox|text.?field|combobox|input|edit/i;
const PASSWORD_FIELD = /(password|passcode|passwd|口令|密码|密碼)/i;
const FORGOT_OR_CHANGE = /forgot|reset|change|忘记|忘記|修改|更换|更換/i;
const PAYMENT_FIELD = /(cvv|cvc|cid|card.?number|credit.?card|debit.?card|expir(y|ation)|security.?code|卡号|卡號|信用卡|有效期|安全码|安全碼)/i;
const PRIVILEGE_SUBJECT = /accessibility|screen.?recording|full.?disk|input.?monitoring|辅助功能|輔助功能|屏幕录制|螢幕錄製|完全磁盘|完全磁碟/i;
const PRIVILEGE_GRANT = /^(allow|grant|open system settings|ok|允许|允許|好|打开系统设置|打開系統設定)$/i;
const PRIVILEGE_GRANT_LOOSE = /\b(allow|grant access|open system settings|允许|允許|打开系统设置|打開系統設定)\b/i;

export type CuaUiHaystack = {
  role?: string;
  label?: string;
  name?: string;
  title?: string;
  value?: string;
  description?: string;
};

export type SensitiveUiKind = "password" | "paymentField" | "privilegeDialog";

function joined(parts: Array<string | undefined | null>): string {
  return parts.filter((item): item is string => typeof item === "string" && item.trim().length > 0).join(" ");
}

function primaryLabel(target: CuaUiHaystack): string {
  return [target.label, target.name, target.title].find((item) => item && item.trim()) ?? "";
}

export function classifySensitiveUiTarget(
  tool: string,
  target: CuaUiHaystack = {},
  context: { app?: string; title?: string } = {},
): SensitiveUiKind | null {
  if (!WRITE_TOOLS.has(tool)) return null;
  const role = target.role ?? "";
  const label = primaryLabel(target);
  const blob = joined([role, label, target.value, target.description, context.app, context.title]);
  if (SECURE_ROLE.test(role) || SECURE_ROLE.test(blob)) return "password";
  if (PASSWORD_FIELD.test(label) && !FORGOT_OR_CHANGE.test(label) && (FIELD_ROLE.test(role) || tool === "set_value" || !role)) {
    return "password";
  }
  // 卡号/CVV 等输入栏硬拦；「用信用卡支付」按钮仍走 ask 确认，不在这里误杀。
  if (PAYMENT_FIELD.test(label) && (FIELD_ROLE.test(role) || tool === "set_value" || !role)) return "paymentField";
  if (PAYMENT_FIELD.test(blob) && FIELD_ROLE.test(role)) return "paymentField";
  if (isDeniedCuaApp([context.app, context.title]) && (PRIVILEGE_GRANT.test(label.trim()) || PRIVILEGE_GRANT_LOOSE.test(label))) {
    return "privilegeDialog";
  }
  if (PRIVILEGE_SUBJECT.test(blob) && (PRIVILEGE_GRANT.test(label.trim()) || PRIVILEGE_GRANT_LOOSE.test(label))) {
    return "privilegeDialog";
  }
  return null;
}

export function sensitiveUiRefusal(
  tool: string,
  args: unknown,
  target: CuaUiHaystack = {},
  context: { app?: string; title?: string } = {},
): "sensitiveTarget" | null {
  const identity = callIdentity(args);
  return classifySensitiveUiTarget(tool, target, {
    app: context.app ?? identity.app,
    title: context.title ?? identity.title,
  }) ? "sensitiveTarget" : null;
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
  requires(owner: string, tool: string, raw: unknown, consume = true): boolean {
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
      if (consume) this.pending.delete(owner);
      return false;
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
