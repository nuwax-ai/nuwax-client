/** webview 是商业版语言来源；壳缺少词典时仅壳回退简体中文。 */
export const NUWAX_WEBVIEW_LANG_KEY = "nuwax.webview_lang";

export function resolveShellLang(lang: unknown): string {
  const normalized = typeof lang === "string" ? lang.trim().toLowerCase() : "";
  if (normalized === "zh-tw" || normalized.startsWith("zh-tw-")) return "zh-tw";
  if (normalized === "zh-hk" || normalized.startsWith("zh-hk-")) return "zh-hk";
  if (normalized === "zh" || normalized.startsWith("zh-")) return "zh-cn";
  if (normalized === "en" || normalized.startsWith("en-")) return "en-us";
  return "zh-cn";
}
