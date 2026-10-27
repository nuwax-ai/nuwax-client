import React from "react";
import styles from "./PageLoadRecovery.module.css";
import { resolveShellLang } from "@shared/utils/shellLanguage";

export type RecoveryMode = "loading" | "waiting" | "failed" | "reloading";
export type RecoveryStage = "load" | "crash" | "resolve" | "services";

/** Local copy: the recovery screen must work before guest/i18n initialization. */
export function recoveryCopy(lang = "zh-CN", stage: RecoveryStage = "load") {
  lang = resolveShellLang(lang);
  if (lang.startsWith("zh")) {
    if (/zh-(tw|hk)/i.test(lang))
      return {
        loading: "正在開啟 Nuwax…",
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
      loading: "正在打开 Nuwax…",
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
    loading: "Opening Nuwax…",
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
            ? copy.failureHint
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
