/** Only failures of the guest main document replace the host UI. */
export interface GuestLoadFailure {
  kind: "load" | "crash" | "resolve";
  url: string;
  code?: number;
  reason?: string;
}

export function diagnosticPageUrl(raw: unknown): string {
  try {
    const url = new URL(String(raw));
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

export function mainDocumentFailure(event: {
  isMainFrame?: boolean;
  errorCode?: number;
  validatedURL?: string;
}): GuestLoadFailure | null {
  // -3 is ERR_ABORTED, expected when another navigation supersedes this one.
  if (event.isMainFrame !== true || event.errorCode === -3) return null;
  return {
    kind: "load",
    url: diagnosticPageUrl(event.validatedURL),
    code: event.errorCode,
  };
}

export function guestFailureCopy(lang: string, kind: GuestLoadFailure["kind"]) {
  if (lang.toLowerCase().startsWith("zh")) {
    const traditional = /zh-(tw|hk)/i.test(lang);
    return traditional
      ? {
          title: kind === "crash" ? "頁面已中斷" : "頁面載入失敗",
          hint:
            kind === "crash" ? "請重新載入頁面。" : "請檢查網絡連線後重試。",
          retry: "重新載入",
        }
      : {
          title: kind === "crash" ? "页面已中断" : "页面加载失败",
          hint:
            kind === "crash" ? "请重新加载页面。" : "请检查网络连接后重试。",
          retry: "重新加载",
        };
  }
  return {
    title:
      kind === "crash"
        ? "The page stopped responding"
        : "Unable to load the page",
    hint:
      kind === "crash"
        ? "Reload the page to continue."
        : "Check your connection and try again.",
    retry: "Reload page",
  };
}
