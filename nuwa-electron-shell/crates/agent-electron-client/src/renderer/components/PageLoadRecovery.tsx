import React, { useEffect, useState } from "react";
import styles from "./PageLoadRecovery.module.css";
import { resolveShellLang } from "@shared/utils/shellLanguage";
import { APP_NAME_IDENTIFIER } from "@shared/constants";
import { isValidServiceHostInput } from "@shared/utils/serviceHostInput";

export type RecoveryMode = "loading" | "waiting" | "failed" | "reloading";
export type RecoveryStage = "load" | "crash" | "resolve" | "services";

/** Local copy: the recovery screen must work before guest/i18n initialization. */
export function recoveryCopy(lang = "zh-CN", stage: RecoveryStage = "load") {
  lang = resolveShellLang(lang);
  if (lang.startsWith("zh")) {
    if (/zh-(tw|hk)/i.test(lang))
      return {
        loading: "正在啟動",
        waiting: "載入時間有點久",
        reloading: "正在重新載入…",
        failed:
          stage === "crash"
            ? "頁面意外中斷"
            : stage === "services"
              ? "本機服務暫未就緒"
              : "暫時無法開啟頁面",
        failureHint:
          stage === "crash"
            ? "重新載入後可繼續使用。"
            : stage === "services"
              ? "請稍後重新載入，再試一次。"
              : "請重新載入後再試，也可以在設定中檢查服務位址。",
        waitingHint: "你可以繼續等待，或重新載入頁面。",
        loadingHint: "準備好後，頁面會自動顯示。",
        reload: "重新載入",
        settings: "設定",
        details: "查看詳細資訊",
        stage: "階段",
        code: "錯誤碼",
      };
    return {
      loading: "正在启动",
      waiting: "加载时间有点久",
      reloading: "正在重新加载…",
      failed:
        stage === "crash"
          ? "页面意外中断"
          : stage === "services"
            ? "本机服务暂未就绪"
            : "暂时无法打开页面",
      failureHint:
        stage === "crash"
          ? "重新加载后可继续使用。"
          : stage === "services"
            ? "请稍后重新加载，再试一次。"
            : "请重新加载后再试，也可以在设置中检查服务地址。",
      waitingHint: "你可以继续等待，或重新加载页面。",
      loadingHint: "准备好后，页面会自动显示。",
      reload: "重新加载",
      settings: "设置",
      details: "查看详细信息",
      stage: "阶段",
      code: "错误码",
    };
  }
  return {
    loading: "Starting",
    waiting: "This is taking a little longer",
    reloading: "Reloading…",
    failed:
      stage === "crash"
        ? "The page was interrupted"
        : stage === "services"
          ? "Local services are not ready yet"
          : "Unable to open the page",
    failureHint:
      stage === "crash"
        ? "Reload the page to continue."
        : stage === "services"
          ? "Wait a moment, then try reloading."
          : "Try reloading, or check the service address in Settings.",
    waitingHint: "You can keep waiting or reload the page.",
    loadingHint: "The page will appear when it is ready.",
    reload: "Reload page",
    settings: "Settings",
    details: "View details",
    stage: "Stage",
    code: "Error code",
  };
}

export interface PageLoadRecoveryProps {
  mode: RecoveryMode;
  stage?: RecoveryStage;
  lang?: string;
  code?: number;
  onReload?: () => void;
  onOpenSettings?: () => void;
  /** Full-window cover stays below the existing 1100 toolbar. */
  overlay?: boolean;
  busy?: boolean;
}

function hostCopy(lang = "zh-CN") {
  const language = resolveShellLang(lang);
  if (language === "en-us") return {
    label: "Service address", edit: "Change service address", save: "Save and restart",
    previous: "Restore previous address", warning: "Changing the address signs you out. The app will restart and you will need to sign in again.",
    dns: "The domain could not be resolved. Check its spelling and network settings.",
    offline: "The network is unavailable. Check your connection.",
    certificate: "The server certificate could not be verified.", timeout: "The connection timed out.",
    probe: "Could not verify this address using the current network or proxy. Check the address and connection. Your session has not been changed.",
    proceed: "Save anyway and restart", failed: "Could not change the address. Please try again.", invalid: "Enter a valid HTTP or HTTPS service address.",
  };
  if (language === "zh-tw" || language === "zh-hk") return {
    label: "服務地址", edit: "修改服務地址", save: "儲存並重新啟動",
    previous: "恢復上一個地址", warning: "修改地址會登出並重新啟動應用程式，之後需要重新登入。",
    dns: "無法解析網域，請檢查拼寫及網絡設定。", offline: "網絡無法連線，請檢查連線。",
    certificate: "無法驗證伺服器憑證。", timeout: "連線逾時。",
    probe: "無法透過目前網絡或代理驗證此地址，請檢查地址及連線。登入狀態尚未更改。",
    proceed: "仍要儲存並重新啟動", failed: "無法修改地址，請重試。", invalid: "請輸入有效的 HTTP 或 HTTPS 服務地址。",
  };
  return {
    label: "服务地址", edit: "修改服务地址", save: "保存并重启",
    previous: "改回上一个地址", warning: "修改地址会退出登录并重启客户端，之后需要重新登录。",
    dns: "域名无法解析，请检查拼写和网络设置。", offline: "网络不可用，请检查网络连接。",
    certificate: "无法验证服务器证书。", timeout: "连接超时。",
    probe: "无法通过当前网络或代理验证此地址，请检查地址和网络。登录状态尚未更改。",
    proceed: "仍要保存并重启", failed: "无法修改地址，请重试。", invalid: "请输入有效的 HTTP 或 HTTPS 服务地址。",
  };
}

function serviceOrigin(value: unknown): string {
  try {
    const url = new URL(String(value));
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.origin : "";
  } catch { return ""; }
}

export function HostRecovery({ lang }: { lang?: string }) {
  const copy = hostCopy(lang);
  const [current, setCurrent] = useState("");
  const [previous, setPrevious] = useState("");
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<"probe" | "failed" | null>(null);
  useEffect(() => {
    let active = true;
    const settings = window.electronAPI?.settings;
    if (settings) void Promise.all([settings.get("step1_config"), settings.get("nuwax.previousServerHost")])
      .then(([config, old]) => {
        if (!active) return;
        const host = serviceOrigin((config as { serverHost?: unknown } | null)?.serverHost);
        setCurrent(host); setDraft(host); setPrevious(serviceOrigin(old));
      }).catch(() => {});
    return () => { active = false; };
  }, []);
  const save = async (host: string, allowUnreachable = false) => {
    if (pending || !isValidServiceHostInput(host)) return;
    setPending(true);
    setProblem(null);
    try {
      const result = await window.electronAPI!.services.configureServerHost(host.trim(), { allowUnreachable, restart: true });
      if (result.probe) setProblem("probe");
      else if (!result.success) setProblem("failed");
    } catch { setProblem("failed"); }
    finally { setPending(false); }
  };
  return <div className={styles.hostRecovery}>
    {current && <p className={styles.currentHost}>{copy.label}: <b>{current}</b></p>}
    {!editing ? <div className={styles.actions}>
      <button className={styles.secondary} type="button" onClick={() => setEditing(true)}>{copy.edit}</button>
      {previous && previous !== current && <button className={styles.secondary} type="button" onClick={() => { setDraft(previous); setEditing(true); }}>{copy.previous}</button>}
    </div> : <form onSubmit={(event) => { event.preventDefault(); void save(draft); }}>
      <label className={styles.hostLabel}>{copy.label}
        <input autoFocus className={styles.hostInput} value={draft} onChange={(event) => { setDraft(event.target.value); setProblem(null); }} disabled={pending} aria-invalid={!isValidServiceHostInput(draft)} />
      </label>
      {!isValidServiceHostInput(draft) && <p className={styles.hostProblem}>{copy.invalid}</p>}
      <p className={styles.hint}>{copy.warning}</p>
      {problem && <p role="alert" className={styles.hostProblem}>{copy[problem]}</p>}
      <div className={styles.actions}>
        <button className={styles.primary} type="submit" disabled={pending || !isValidServiceHostInput(draft)}>{copy.save}</button>
        {problem === "probe" && <button className={styles.secondary} type="button" disabled={pending} onClick={() => void save(draft, true)}>{copy.proceed}</button>}
      </div>
    </form>}
  </div>;
}

export function PageLoadRecovery({
  mode,
  stage = "load",
  lang,
  code,
  onReload,
  onOpenSettings,
  overlay = false,
  busy = mode === "reloading",
}: PageLoadRecoveryProps) {
  const copy = recoveryCopy(lang, stage);
  const hostText = hostCopy(lang);
  const networkHint = stage === "load" ? ({ [-105]: hostText.dns, [-106]: hostText.offline, [-202]: hostText.certificate, [-118]: hostText.timeout } as Record<number, string>)[code ?? 0] : undefined;
  const actionable = mode !== "loading";
  return (
    <div
      className={`${styles.surface}${overlay ? ` ${styles.overlay}` : ""}`}
      data-recovery-state={mode}
    >
      <section
        className={styles.card}
        role={mode === "failed" ? "alert" : "status"}
        aria-live="polite"
        aria-atomic="true"
      >
        <div className={styles.iconFrame}>
          <img
            className={styles.icon}
            src="./icon.png"
            alt=""
            width="48"
            height="48"
          />
        </div>
        <h1 className={styles.title}>{copy[mode]}</h1>
        <p className={styles.hint}>
          {mode === "failed"
            ? networkHint || copy.failureHint
            : mode === "waiting"
              ? copy.waitingHint
              : copy.loadingHint}
        </p>
        {actionable && (
          <div className={styles.actions}>
            {onReload && (
              <button
                className={styles.primary}
                type="button"
                onClick={onReload}
                disabled={busy}
                aria-busy={busy}
              >
                {busy ? copy.reloading : copy.reload}
              </button>
            )}
            {onOpenSettings && (
              <button
                className={styles.secondary}
                type="button"
                onClick={onOpenSettings}
              >
                {copy.settings}
              </button>
            )}
          </div>
        )}
        {mode === "failed" && APP_NAME_IDENTIFIER === "nuwax" && <HostRecovery lang={lang} />}
        {mode !== "loading" && (
          <details className={styles.details}>
            <summary>{copy.details}</summary>
            {/* Whitelist only. Never display URLs, arbitrary backend errors, or crash payloads. */}
            <dl>
              <dt>{copy.stage}</dt>
              <dd>{stage}</dd>
              {Number.isFinite(code) && (
                <>
                  <dt>{copy.code}</dt>
                  <dd>{code}</dd>
                </>
              )}
            </dl>
          </details>
        )}
      </section>
    </div>
  );
}
