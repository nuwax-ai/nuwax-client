import React, { useEffect, useState } from "react";
import { Button, Select, Space, Tag, message, theme } from "antd";
import type { ComputerUseAPI } from "@shared/features/computer-use/contract";
import type { CuaCheck, CuaRuntime, CuaWindow } from "@shared/features/computer-use/contract";

import { CUA_CONTROL_INITIAL_POSITION, CUA_REASON_KEYS } from "@shared/features/computer-use/presentation";
import { CuaTaskCenter } from "./CuaTaskCenter";
import styles from "./CuaControls.module.css";
const REASONS = new Set(CUA_REASON_KEYS);
type T = (key: string, ...args: any[]) => string;
const reasonText = (t: T, reason: string) => t(`Claw.Cua.reason.${REASONS.has(reason) ? reason : "generic"}`);

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
      if (result?.success === false && !result.cancelled) message.error(reasonText(t, result.error));
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
    <CuaControlBar api={api} runtime={runtime} accept={accept} t={t} /></>;
}
type ControlIconName = "desktop" | "window" | "pause" | "resume" | "takeover" | "stop" | "close";
function ControlIcon({ name }: { name: ControlIconName }) {
  const paths: Record<ControlIconName, React.ReactNode> = {
    desktop: <><rect x="3" y="3" width="18" height="13" rx="3" /><path d="M8 21h8M12 16v5" /></>,
    window: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M3 9h18M7 6.5h.01M10 6.5h.01" /></>,
    pause: <><path d="M8 5v14M16 5v14" /></>,
    resume: <path d="m8 5 11 7-11 7Z" />,
    takeover: <><path d="m5 3 14 9-7 1-3 7Z" /><path d="m13 13 5 7" /></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
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
  if (!api?.getRuntime || !runtime || !["running", "paused"].includes(runtime.phase) || closed === runtime.taskId || runtime.multiwindow) return null;

  const paused = runtime.phase === "paused";
  const target = runtime.scope?.kind === "window" ? runtime.scope.label || t("Claw.Cua.scope.choose") : t("Claw.Cua.scope.desktop");
  const controlLocked = busy || runtime.controlPending;
  const status = t(runtime.controlPending ? "Claw.Cua.stopping" : `Claw.Cua.phase.${runtime.phase}`);
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
      <Button type="text" className={styles.close} aria-label={t("Claw.Cua.preview.close")} title={t("Claw.Cua.preview.close")}
        icon={<ControlIcon name="close" />} onClick={() => setClosed(runtime.taskId)} />
    </header>
    <div className={styles.actions}>
      <Button type="text" className={styles.pause} disabled={controlLocked} icon={<ControlIcon name={paused ? "resume" : "pause"} />}
        aria-label={t(paused ? "Claw.Cua.resume" : "Claw.Cua.pause")} title={t(paused ? "Claw.Cua.resume" : "Claw.Cua.pause")}
        onClick={() => void run(() => paused ? api.resume() : api.pause())}>{t(paused ? "Claw.Cua.preview.resume" : "Claw.Cua.preview.pause")}</Button>
      <Button danger className={styles.stop} icon={<ControlIcon name="stop" />} onClick={() => void run(() => api.stop())}>{t("Claw.Cua.stop")}</Button>
    </div>
  </aside>;
}

type Row = (props: { label: React.ReactNode; desc?: React.ReactNode; control?: React.ReactNode }) => React.ReactElement;

/**
 * Settings rows for the operating scope and diagnostics. Window mode is the only way to let the
 * agent use a browser the user is logged into, so scope selection must stay reachable here.
 */
export function CuaSettingsRows({ api, t, Row }: { api?: ComputerUseAPI; t: T; Row: Row }) {
  const [runtime, accept] = useCuaRuntime(api);
  const { busy, run } = useCuaAction(t, accept);
  const [windows, setWindows] = useState<CuaWindow[]>([]);
  const [loadingWindows, setLoadingWindows] = useState(false);
  const [checks, setChecks] = useState<CuaCheck[] | null>(null);
  if (!api?.getRuntime || !runtime) return null;

  const taskActive = ["running", "paused"].includes(runtime.phase);
  const scope = runtime.scope;
  const selected = scope?.kind === "window" ? `${scope.pid}:${scope.windowId}` : "desktop";
  const options = [
    { value: "desktop", label: t("Claw.Cua.scope.desktop") },
    // A restored window preference has no live target until the user picks one again.
    ...(scope?.kind === "window" && !windows.some((item) => `${item.pid}:${item.windowId}` === selected)
      ? [{ value: selected, label: scope.label || t("Claw.Cua.scope.choose") }] : []),
    ...windows.map((item) => ({ value: `${item.pid}:${item.windowId}`, label: item.label })),
  ];
  // Not through `run`: its busy flag disables the select, which would close the list being opened.
  const loadWindows = async () => {
    setLoadingWindows(true);
    try {
      const result = await api.listWindows();
      if (result?.windows) setWindows(result.windows);
      else if (result?.success === false) message.error(reasonText(t, result.error ?? "generic"));
    } catch { message.error(t("Claw.Cua.reason.generic")); }
    finally { setLoadingWindows(false); }
  };
  const choose = (value: string) => {
    if (value === "desktop") { void run(() => api.setScope({ kind: "desktop" })); return; }
    const target = windows.find((item) => `${item.pid}:${item.windowId}` === value);
    if (target) void run(() => api.setScope({ kind: "window", pid: target.pid, windowId: target.windowId }));
  };
  const selfTest = async () => {
    const result = await run(() => api.selfTest());
    if (result?.checks) setChecks(result.checks);
  };
  return <>
    {api.setMultiwindowEnabled && <Row label={t("Claw.Cua.multiwindow.title")}
      desc={<>{t("Claw.Cua.multiwindow.description")} {t("Claw.Cua.multiwindow.manageFromTray")}</>}
      control={<Space wrap size={6} style={{ justifyContent: "flex-end" }}><Button size="small" loading={busy} onClick={() => void run(() => api.setMultiwindowEnabled(!runtime.multiwindow))}>
        {t(runtime.multiwindow ? "Claw.Cua.multiwindow.disable" : "Claw.Cua.multiwindow.enable")}
      </Button>{runtime.recoverable && <Button size="small" disabled={busy || !!runtime.controlPending}
        onClick={() => void run(() => api.recover())}>{t("Claw.Cua.recover")}</Button>}</Space>} />}
    {!runtime.multiwindow && <Row
      label={t("Claw.Settings.computerUse.scope")}
      desc={t("Claw.Cua.scope.explanation")}
      control={<Select aria-label={t("Claw.Settings.computerUse.scope")} style={{ width: 240 }}
        size="small" popupMatchSelectWidth={false} value={selected} options={options} loading={loadingWindows}
        disabled={busy || runtime.controlPending || taskActive}
        onDropdownVisibleChange={(open) => { if (open) void loadWindows(); }}
        onChange={choose} />}
    />}
    <Row
      label={t("Claw.Settings.computerUse.diagnostics")}
      desc={<>
        {t("Claw.Cua.privacy")}
        {checks && <span role="status" style={{ display: "block", marginTop: 4 }}>
          {checks.map((check) => `${t(`Claw.Cua.check.${check.name}`)}：${t(`Claw.Cua.check.${check.status}`)}${check.reason
            ? `（${check.name === "model" ? t("Claw.Cua.modelCheck") : reasonText(t, check.reason)}）` : ""}`).join("；")}
        </span>}
      </>}
      control={<Space wrap size={6} style={{ maxWidth: 240, justifyContent: "flex-end" }}>
        <Button size="small" loading={busy} onClick={() => void selfTest()}>{t("Claw.Cua.selfTest")}</Button>
        <Button size="small" onClick={() => void run(() => api.exportDiagnostics())}>{t("Claw.Cua.export")}</Button>
        <Button size="small" disabled={taskActive} onClick={() => void run(async () => {
          const result = await api.clearHistory(); accept(await api.getRuntime()); return result;
        })}>{t("Claw.Cua.clear")}</Button>
      </Space>}
    />
  </>;
}
