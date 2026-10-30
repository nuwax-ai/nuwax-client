import React, { useEffect, useState } from "react";
import { Button, Switch, Tooltip, message, theme } from "antd";
import type { ComputerUseAPI, CuaRuntime } from "@shared/features/computer-use/contract";

import { CUA_CONTROL_INITIAL_POSITION, canShowCuaOverlay, cuaRuntimeForConversation, cuaOverlayNotice, cuaReasonKey } from "@shared/features/computer-use/presentation";
import { CuaTaskCenter } from "./CuaTaskCenter";
import styles from "./CuaControls.module.css";
type T = (key: string, ...args: any[]) => string;
const reasonText = (t: T, reason?: string | null) => t(`Claw.Cua.reason.${cuaReasonKey(reason)}`);

/** Live runtime with stale snapshots dropped; shared by the control bar and the settings rows. */
function useCuaRuntime(api?: ComputerUseAPI) {
  const [runtime, setRuntime] = useState<CuaRuntime | null>(null);
  const accept = (state: CuaRuntime) => setRuntime((current) =>
    !current || state.revision >= current.revision ? state : current);
  useEffect(() => {
    if (!api?.getRuntime) return;
    let active = true;
    const refresh = () => { void api.getRuntime().then((state) => { if (active) accept(state); }).catch(() => undefined); };
    const listener = (state: unknown) => { if (active && state) accept(state as CuaRuntime); };
    refresh();
    window.electronAPI?.on("cua:runtime", listener);
    window.addEventListener("focus", refresh);
    return () => { active = false; window.removeEventListener("focus", refresh); window.electronAPI?.off("cua:runtime", listener); };
  }, [api]);
  return [runtime, accept] as const;
}

function useCuaAction(t: T, accept: (state: CuaRuntime) => void) {
  const [busy, setBusy] = useState(false);
  const run = async <R,>(action: () => Promise<R>): Promise<R | undefined> => {
    setBusy(true);
    try {
      const result = await action() as any;
      if (result?.runtime) accept(result.runtime);
      if (result?.success === false && !result.cancelled) message.error(reasonText(t, result.error as string | undefined));
      return result;
    } catch { message.error(t("Claw.Cua.reason.generic")); }
    finally { setBusy(false); }
  };
  return { busy, run };
}

/** Floating control bar; only visible while a task exists. */
export function CuaControls({ api, t }: { api?: ComputerUseAPI; t: T }) {
  const [runtime, accept] = useCuaRuntime(api);
  return <><CuaTaskCenter api={api} runtime={runtime} accept={accept} t={t} />
    <CuaControlBar api={api} runtime={runtime ? cuaRuntimeForConversation(runtime, runtime.presentationConversationId ?? null) : null} accept={accept} t={t} /></>;
}
type ControlIconName = "desktop" | "window" | "pause" | "resume" | "takeover" | "close" | "stop" | "confirm";
function ControlIcon({ name }: { name: ControlIconName }) {
  const paths: Record<ControlIconName, React.ReactNode> = {
    desktop: <><rect x="3" y="3" width="18" height="13" rx="3" /><path d="M8 21h8M12 16v5" /></>,
    window: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M3 9h18M7 6.5h.01M10 6.5h.01" /></>,
    pause: <><path d="M8 5v14M16 5v14" /></>,
    resume: <path d="m8 5 11 7-11 7Z" />,
    takeover: <><path d="m5 3 14 9-7 1-3 7Z" /><path d="m13 13 5 7" /></>,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
    confirm: <path d="m5 12 4 4L19 6" />,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

/** Keep the entire card inside the host content area after dragging or resizing. */
export function clampCuaControlPosition(point: { x: number; y: number }, size: { width: number; height: number }, viewport: { width: number; height: number }) {
  const inset = 8;
  const maxX = Math.max(inset, viewport.width - size.width - inset);
  const maxY = Math.max(inset, viewport.height - size.height - inset);
  return { x: Math.max(inset, Math.min(point.x, maxX)), y: Math.max(Math.min(48, maxY), Math.min(point.y, maxY)) };
}

function CuaControlBar({ api, runtime, accept, t }: { api?: ComputerUseAPI; runtime: CuaRuntime | null; accept: (state: CuaRuntime) => void; t: T }) {
  const { token } = theme.useToken();
  const [closed, setClosed] = useState<string | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const panel = React.useRef<HTMLElement | null>(null);
  const drag = React.useRef<{ x: number; y: number; left: number; top: number; width: number; height: number } | null>(null);
  const { busy, run } = useCuaAction(t, accept);
  useEffect(() => {
    const show = () => setClosed(null);
    window.electronAPI?.on("cua:showPreview", show);
    return () => window.electronAPI?.off("cua:showPreview", show);
  }, []);
  useEffect(() => {
    const constrain = () => {
      if (!panel.current) return;
      const size = panel.current.getBoundingClientRect();
      setPosition(current => current ? clampCuaControlPosition(current, size, { width: window.innerWidth, height: window.innerHeight }) : null);
    };
    window.addEventListener("resize", constrain);
    return () => window.removeEventListener("resize", constrain);
  }, [runtime?.phase, runtime?.reason, runtime?.needsObservation]);
  if (!api?.getRuntime || !runtime || closed === runtime.taskId || !canShowCuaOverlay(runtime)) return null;

  const paused = runtime.phase === "paused";
  const target = runtime.scope?.kind === "window" ? runtime.scope.label || t("Claw.Cua.scope.choose") : t("Claw.Cua.scope.desktop");
  const controlLocked = busy || runtime.controlPending;
  const status = t(runtime.controlPending ? "Claw.Cua.stopping" : `Claw.Cua.phase.${runtime.phase}`);
  // Operational pauses (noProgress / userPaused) stay in the tray; only actionable failures land here.
  const notice = !runtime.controlPending ? cuaOverlayNotice(runtime.reason) : null;
  const handoffLabel = t("Claw.Cua.preview.legacyTakeover");
  return <aside ref={panel} className={styles.card} data-phase={runtime.controlPending ? "pending" : runtime.phase}
    aria-label={t("Claw.Cua.title")} style={{
      top: position?.y ?? CUA_CONTROL_INITIAL_POSITION.top, right: position ? undefined : CUA_CONTROL_INITIAL_POSITION.right, left: position?.x,
      "--cua-bg": token.colorBgElevated, "--cua-text": token.colorText, "--cua-muted": token.colorTextSecondary,
      "--cua-line": token.colorBorderSecondary, "--cua-accent": token.colorPrimary,
    } as React.CSSProperties}>
    <header className={styles.header}
      onPointerDown={event => {
        if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
        const box = panel.current!.getBoundingClientRect();
        drag.current = { x: event.clientX, y: event.clientY, left: box.left, top: box.top, width: box.width, height: box.height };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        if (!drag.current) return;
        const d = drag.current;
        setPosition(clampCuaControlPosition({ x: d.left + event.clientX - d.x, y: d.top + event.clientY - d.y }, d,
          { width: window.innerWidth, height: window.innerHeight }));
      }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      <span className={styles.brandIcon}><ControlIcon name={runtime.scope?.kind === "window" ? "window" : "desktop"} /></span>
      <Button type="text" className={styles.heading} disabled={controlLocked} title={handoffLabel}
        aria-label={t("Claw.Cua.preview.takeover")} onClick={() => void run(() => api.takeOver())}>{target}</Button>
      <span className={styles.status} role="status"><i />{status}</span>
    </header>
    {notice && <p className={styles.notice} role="status">{reasonText(t, notice)}</p>}
    <div className={styles.actions}>
      {["running", "paused"].includes(runtime.phase) && <Tooltip title={t(paused ? "Claw.Cua.resume" : "Claw.Cua.pause")} trigger={["hover", "focus"]} zIndex={10000}>
        <span className={styles.actionSlot}><Button type="text" className={styles.pause} disabled={controlLocked} icon={<ControlIcon name={paused ? "resume" : "pause"} />}
          aria-label={t(paused ? "Claw.Cua.resume" : "Claw.Cua.pause")}
          onClick={() => void run(() => paused ? api.resume() : api.pause())} /></span>
      </Tooltip>}
      {runtime.reason === "confirmationRequired" && api.confirmSensitive && <Tooltip title={t("Claw.Cua.confirmAllow")} trigger={["hover", "focus"]} zIndex={10000}>
        <span className={styles.actionSlot}><Button size="small" icon={<ControlIcon name="confirm" />} aria-label={t("Claw.Cua.confirmAllow")}
          onClick={() => void run(async () => { const allowed = await api.confirmSensitive!(true); return allowed.success ? api.resume() : { success: false, error: "operationCancelled" }; })} /></span>
      </Tooltip>}
      {api.stopTask && <Tooltip title={t("Claw.Cua.stopCurrent")} trigger={["hover", "focus"]} zIndex={10000}>
        <span className={styles.actionSlot}><Button size="small" icon={<ControlIcon name="stop" />} aria-label={t("Claw.Cua.stopCurrent")} disabled={controlLocked}
          onClick={() => void run(() => api.stopTask(runtime.taskId!))} /></span>
      </Tooltip>}
    </div>
  </aside>;
}

type Row = (props: { label: React.ReactNode; desc?: React.ReactNode; control?: React.ReactNode }) => React.ReactElement;

/** Settings extras: recovery only. Scope, diagnostics and window pickers stay out of the ordinary UI. */
export function CuaSettingsRows({ api, t, Row }: { api?: ComputerUseAPI; t: T; Row: Row }) {
  const [runtime, accept] = useCuaRuntime(api);
  const { busy, run } = useCuaAction(t, accept);
  if (!api?.getRuntime || !runtime) return null;
  // Keep an explicit entry for fresh profiles, which retain the legacy mode until selected.
  const supportsMultiwindow = typeof navigator !== "undefined" && /mac|win/i.test(navigator.platform);
  return <>{supportsMultiwindow && api.setMultiwindowEnabled && <Row label={t("Claw.Cua.multiwindow.enable")}
    desc={t("Claw.Cua.multiwindow.description")}
    control={<Switch checked={runtime.multiwindow === true} loading={busy} disabled={!!runtime.controlPending}
      onChange={enabled => void run(() => api.setMultiwindowEnabled(enabled))} />} />}
    {runtime.recoverable && <Row label={t("Claw.Cua.recover")} desc={t("Claw.Cua.recoverHint")}
    control={<Button size="small" loading={busy} disabled={!!runtime.controlPending}
      onClick={() => void run(() => api.recover())}>{t("Claw.Cua.recover")}</Button>} />}</>;
}
