/**
 * NuwaxHostWebview - 客户端主窗口宿主组件（沉浸式）。
 *
 * 全屏嵌入 nuwax PC 站点（含登录页），作为客户端主界面。站内 webview 占满整窗，
 * 收银台外域整页在顶部留出壳工具栏高度，
 * 顶部覆盖层（红绿灯后工具栏 TrafficLightToolbar）由 App.tsx 渲染，承载窗口拖拽、
 * webview 导航（后退/前进/刷新）、二级菜单收起、设置入口与账号/更新状态。
 *
 * 本组件通过 forwardRef 暴露 webview 导航与宿主命令下发能力，并经 onNavStateChange
 * 上报 canGoBack/canGoForward 供工具栏按钮启用态。鉴权交给 nuwax 自身 /Login +
 * NuwaClawBridge.auth（ACCESS_TOKEN 双向同步，重启免登）。
 *
 * 沉浸式：mac 沿用原生红绿灯（main.ts titleBarStyle:"hidden"）；Win/Linux 窗口控制
 * 由 TrafficLightToolbar 自绘（不再在此组件渲染）。
 */
import React, {
  useEffect,
  useRef,
  useState,
  useImperativeHandle,
  forwardRef,
} from "react";
import { APP_NAME_IDENTIFIER, DEFAULT_SERVER_HOST } from "@shared/constants";
import { normalizeServerHost } from "../../services/core/auth";
import { buildHomeUrl } from "../../services/utils/sessionUrl";
import { logger } from "../../services/utils/logService";
import type { GuestLoadPhase } from "../../bootTiming";
import { PageLoadRecovery } from "../PageLoadRecovery";
import { GuestPageViewport } from "../GuestPageViewport";
import { DistSnapshotNotice } from "../DistSnapshotNotice";
import { getCurrentLang } from "../../services/core/i18n";
import {
  diagnosticPageUrl,
  mainDocumentFailure,
  type GuestLoadFailure,
} from "../../services/webviewLoadFailure";

export const GUEST_SLOW_HINT_MS = 15_000;
export interface NuwaxHostWebviewHandle {
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  sendHostCommand: (payload: unknown) => void;
  navigate: (url: string) => void;
}
export interface NuwaxHostWebviewProps {
  reloadKey?: number;
  onNavStateChange?: (state: {
    canGoBack: boolean;
    canGoForward: boolean;
  }) => void;
  onNavigationStart?: (event?: { isInPlace?: boolean }) => void;
  onGuestLoadStateChange?: (phase: GuestLoadPhase) => void;
  onOpenSettings?: () => void;
}

const NuwaxHostWebview = forwardRef<
  NuwaxHostWebviewHandle,
  NuwaxHostWebviewProps
>(function NuwaxHostWebview(
  {
    reloadKey = 0,
    onNavStateChange,
    onNavigationStart,
    onGuestLoadStateChange,
    onOpenSettings,
  },
  ref,
) {
  const [url, setUrl] = useState("");
  const [pageUrl, setPageUrl] = useState("");
  const [failure, setFailure] = useState<GuestLoadFailure | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [ua, setUa] = useState<string | undefined>();
  const [webviewEpoch, setWebviewEpoch] = useState(0);
  const webviewRef = useRef<HTMLElement | null>(null);
  const generation = useRef(0);
  const activity = useRef(0);
  const loading = useRef(false);
  const reloadLocked = useRef(false);
  const failureRef = useRef<GuestLoadFailure | null>(null);
  const activeDocument = useRef("");
  const slowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbacks = useRef({
    onNavStateChange,
    onNavigationStart,
    onGuestLoadStateChange,
  });
  callbacks.current = {
    onNavStateChange,
    onNavigationStart,
    onGuestLoadStateChange,
  };

  const clearSlowTimer = () => {
    if (slowTimer.current !== null) clearTimeout(slowTimer.current);
    slowTimer.current = null;
  };
  const beginLoading = (phase: GuestLoadPhase, fresh = false) => {
    if (loading.current && !fresh) return;
    clearSlowTimer();
    const currentGeneration = generation.current;
    const currentActivity = ++activity.current;
    loading.current = true;
    setWaiting(false);
    callbacks.current.onGuestLoadStateChange?.(phase);
    slowTimer.current = setTimeout(() => {
      if (
        generation.current !== currentGeneration ||
        activity.current !== currentActivity
      )
        return;
      slowTimer.current = null;
      // A hint is not a timeout: the live guest and its pending requests stay mounted.
      setWaiting(true);
      reloadLocked.current = false;
      setReloading(false);
      callbacks.current.onGuestLoadStateChange?.("waiting");
    }, GUEST_SLOW_HINT_MS);
  };
  const finishLoading = () => {
    clearSlowTimer();
    loading.current = false;
    reloadLocked.current = false;
    setWaiting(false);
    setReloading(false);
  };
  const showFailure = (next: GuestLoadFailure) => {
    finishLoading();
    failureRef.current = next;
    setFailure(next);
    callbacks.current.onGuestLoadStateChange?.("failed");
  };
  const rebuildGuest = () => {
    // Invalidate old callbacks synchronously, before React has detached the old node.
    ++generation.current;
    clearSlowTimer();
    loading.current = false;
    setWaiting(false);
    failureRef.current = null;
    setFailure(null);
    activeDocument.current = "";
    setPageUrl("");
    setHasLoaded(false);
    setUrl("");
    setWebviewEpoch((epoch) => epoch + 1);
  };

  useEffect(() => {
    let active = true;
    window.electronAPI?.app
      .getVersion()
      .then((version) => {
        if (!active) return;
        const token = `@nuwax-ai/${APP_NAME_IDENTIFIER}/${version}`;
        setUa(
          navigator.userAgent.includes(token)
            ? navigator.userAgent
            : `${navigator.userAgent} ${token}`,
        );
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key === "F12" ||
        (event.metaKey && event.altKey && event.key.toLowerCase() === "i")
      ) {
        const guest = webviewRef.current as any;
        if (guest?.isDevToolsOpened?.()) guest.closeDevTools?.();
        else guest?.openDevTools?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const changed = () => {
      reloadLocked.current = false;
      setReloading(false);
      // A new domain needs a new guest: trusted preload origins are captured at attach.
      rebuildGuest();
    };
    window.electronAPI?.on("nuwax:loopback-changed", changed as any);
    window.electronAPI?.on("nuwax:serverHostChanged", changed as any);
    return () => {
      window.electronAPI?.off("nuwax:loopback-changed", changed as any);
      window.electronAPI?.off("nuwax:serverHostChanged", changed as any);
    };
  }, []);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    let cancelled = false;
    failureRef.current = null;
    setFailure(null);
    beginLoading("resolving", true);
    void (async () => {
      try {
        const step1 = (await window.electronAPI?.settings.get(
          "step1_config",
        )) as { serverHost?: string } | null;
        const loopback = (await window.electronAPI?.settings.get(
          "nuwax.loopback",
        )) as { enabled?: boolean; origin?: string | null } | null;
        const override = (await window.electronAPI?.settings.get(
          "nuwax.webviewOverride",
        )) as { origin?: string | null } | null;
        if (cancelled || currentGeneration !== generation.current) return;
        const rawHost =
          override?.origin ||
          (loopback?.enabled && loopback.origin) ||
          step1?.serverHost ||
          DEFAULT_SERVER_HOST;
        const domain = normalizeServerHost(rawHost);
        const finalUrl = buildHomeUrl(domain);
        const target = new URL(finalUrl);
        if (
          !domain ||
          !["http:", "https:"].includes(target.protocol) ||
          target.username ||
          target.password
        )
          throw new Error("Invalid webview origin");
        activeDocument.current = finalUrl;
        logger.info(
          "[NuwaxHostWebview] resolved webview url",
          "NuwaxHostWebview",
          { url: diagnosticPageUrl(finalUrl) },
        );
        setUrl(finalUrl);
      } catch {
        if (cancelled || currentGeneration !== generation.current) return;
        logger.error(
          "[NuwaxHostWebview] resolve url failed",
          "NuwaxHostWebview",
        );
        showFailure({ kind: "resolve", url: "" });
      }
    })();
    return () => {
      cancelled = true;
      clearSlowTimer();
    };
    // Epoch is the sole source of guest recreation; callbacks are read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webviewEpoch]);

  useEffect(() => {
    const guest = webviewRef.current as any;
    if (!url || !guest?.addEventListener) return;
    const currentGeneration = generation.current;
    const current = () =>
      generation.current === currentGeneration && webviewRef.current === guest;
    const sync = (event?: { url?: string }) => {
      if (!current()) return;
      const nextUrl = event?.url || guest.getURL?.();
      if (typeof nextUrl === "string") {
        activeDocument.current = nextUrl;
        setPageUrl(nextUrl);
      }
      callbacks.current.onNavStateChange?.({
        canGoBack: !!guest.canGoBack?.(),
        canGoForward: !!guest.canGoForward?.(),
      });
    };
    const navigationStarted = (event: {
      isMainFrame?: boolean;
      isInPlace?: boolean;
      url?: string;
    }) => {
      if (!current() || event.isMainFrame !== true) return;
      if (event.url) activeDocument.current = event.url;
      if (!event.isInPlace) {
        failureRef.current = null;
        setFailure(null);
        beginLoading("loading", true);
      }
      callbacks.current.onNavigationStart?.({ isInPlace: event.isInPlace });
    };
    const failed = (event: Parameters<typeof mainDocumentFailure>[0]) => {
      if (!current()) return;
      const next = mainDocumentFailure(event, activeDocument.current);
      if (!next) return;
      showFailure(next);
      logger.error(
        "[NuwaxHostWebview] main document failed",
        "NuwaxHostWebview",
        next,
      );
    };
    const crashed = () => {
      if (!current()) return;
      // Arbitrary native crash detail is deliberately not rendered or logged here.
      showFailure({
        kind: "crash",
        url: diagnosticPageUrl(activeDocument.current),
      });
      logger.error("[NuwaxHostWebview] renderer gone", "NuwaxHostWebview");
    };
    const started = () => {
      if (current() && !failureRef.current) beginLoading("loading");
    };
    const stopped = () => {
      if (!current() || failureRef.current) return;
      finishLoading();
      setHasLoaded(true);
      // Only transport loading stopped. PC Web owns its own business-ready state.
      callbacks.current.onGuestLoadStateChange?.("stopped");
    };
    const listeners = {
      "dom-ready": sync,
      "did-start-navigation": navigationStarted,
      "did-navigate": sync,
      "did-navigate-in-page": sync,
      "did-start-loading": started,
      "did-stop-loading": stopped,
      "did-fail-load": failed,
      "render-process-gone": crashed,
    };
    for (const [name, listener] of Object.entries(listeners))
      guest.addEventListener(name, listener);
    return () => {
      for (const [name, listener] of Object.entries(listeners))
        guest.removeEventListener?.(name, listener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, webviewEpoch]);

  const reload = () => {
    if (reloadLocked.current) return;
    reloadLocked.current = true;
    setReloading(true);
    setWaiting(false);
    const guest = webviewRef.current as any;
    if (failureRef.current || !url || !guest?.reload) {
      rebuildGuest();
      return;
    }
    const currentGeneration = generation.current;
    beginLoading("loading", true);
    const currentActivity = activity.current;
    const rejected = () => {
      if (
        currentGeneration === generation.current &&
        currentActivity === activity.current
      )
        showFailure({
          kind: "load",
          url: diagnosticPageUrl(activeDocument.current),
        });
    };
    try {
      const result = guest.reload();
      if (result && typeof result.catch === "function")
        void result.catch(rejected);
    } catch {
      rejected();
    }
  };
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    if (reloadKey > 0) reloadRef.current();
  }, [reloadKey]);

  useImperativeHandle(
    ref,
    () => ({
      goBack: () => (webviewRef.current as any)?.goBack?.(),
      goForward: () => (webviewRef.current as any)?.goForward?.(),
      reload,
      canGoBack: () => !!(webviewRef.current as any)?.canGoBack?.(),
      canGoForward: () => !!(webviewRef.current as any)?.canGoForward?.(),
      sendHostCommand: (payload: unknown) =>
        (webviewRef.current as any)?.send?.("nuwax:host-command", payload),
      navigate: (targetUrl: string) => {
        try {
          const target = new URL(targetUrl);
          const source = new URL(url);
          if (
            ["http:", "https:"].includes(target.protocol) &&
            !target.username &&
            !target.password &&
            target.origin === source.origin
          ) {
            const result = (webviewRef.current as any)?.loadURL?.(target.href);
            if (result && typeof result.catch === "function")
              void result.catch(() => {});
          }
        } catch {
          /* No programmatic navigation before the business URL resolves. */
        }
      },
    }),
    [url, failure],
  );

  const recoveryMode = failure
    ? "failed"
    : waiting
      ? "waiting"
      : reloading
        ? "reloading"
        : !url || !hasLoaded
          ? "loading"
          : null;
  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        background: "var(--color-bg-layout, #f7f8fa)",
        overflow: "hidden",
      }}
    >
      <GuestPageViewport pageUrl={pageUrl}>
        {url && (
          <webview
            key={webviewEpoch}
            ref={webviewRef as any}
            src={url}
            useragent={ua}
            allowpopups={"true" as any}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              border: "none",
            }}
          />
        )}
      </GuestPageViewport>
      {!recoveryMode && <DistSnapshotNotice key={url} guestUrl={pageUrl || url} onOpenSettings={onOpenSettings} />}
      {recoveryMode && (
        <PageLoadRecovery
          mode={recoveryMode}
          stage={failure?.kind || (!url ? "resolve" : "load")}
          lang={getCurrentLang()}
          code={failure?.code}
          onReload={reload}
          onOpenSettings={onOpenSettings}
        />
      )}
    </div>
  );
});

export default NuwaxHostWebview;
