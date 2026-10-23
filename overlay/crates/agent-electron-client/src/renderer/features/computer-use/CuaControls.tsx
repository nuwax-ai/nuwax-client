import React, { useEffect, useState } from "react";
import { Button, Select, Space, Tag, message, theme } from "antd";
import type { ComputerUseAPI } from "@shared/features/computer-use/contract";
import type { CuaCheck, CuaRuntime, CuaWindow } from "@shared/features/computer-use/contract";

import { CUA_REASON_KEYS, actionKind } from "@shared/features/computer-use/presentation";
import { CuaTaskCenter } from "./CuaTaskCenter";
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
function CuaControlBar({ api, runtime, accept, t }: { api?: ComputerUseAPI; runtime: CuaRuntime | null; accept: (state: CuaRuntime) => void; t: T }) {
  const { token } = theme.useToken();
  const [closed, setClosed] = useState<string | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const drag = React.useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const { busy, run } = useCuaAction(t, accept);
  useEffect(() => {
    const show = () => setClosed(null);
    window.electronAPI?.on("cua:showPreview", show);
    return () => window.electronAPI?.off("cua:showPreview", show);
  }, []);
  if (!api?.getRuntime || !runtime || !["running", "paused"].includes(runtime.phase) || closed === runtime.taskId) return null;
  // Multiwindow tasks use the contained host view; avoid a duplicate control bar.
  if (runtime.multiwindow) return null;

  const reason = runtime.reason ? reasonText(t, runtime.reason) : null;
  const currentStep = runtime.steps.at(-1);
  return <aside aria-label={t("Claw.Cua.title")} aria-live="polite" style={{
    position: "fixed", top: position?.y ?? 48, right: position ? undefined : 16, left: position?.x, zIndex: 9999,
    width: 300, maxWidth: "calc(100% - 32px)", padding: "8px 10px", borderRadius: 12,
    background: token.colorBgElevated, color: token.colorText,
    boxShadow: "0 4px 24px #0003", border: "1px solid #8884",
  }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "grab", touchAction: "none" }}
      onPointerDown={event => { if ((event.target as HTMLElement).closest("button")) return;
        const box = event.currentTarget.parentElement!.getBoundingClientRect(); drag.current = { x: event.clientX, y: event.clientY, left: box.left, top: box.top }; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (!drag.current) return; const d = drag.current;
        setPosition({ x: Math.max(0, Math.min(d.left + event.clientX - d.x, window.innerWidth - 316)), y: Math.max(0, Math.min(d.top + event.clientY - d.y, window.innerHeight - 180)) }); }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      <strong>{t("Claw.Cua.title")}</strong><Button type="text" size="small" aria-label={t("Claw.Cua.preview.close")} onClick={() => setClosed(runtime.taskId)}>×</Button>
    </div>
    <Space wrap>
      <Tag color={runtime.phase === "running" ? "processing" : runtime.phase === "failed" ? "error" : "default"}>
        {t(runtime.controlPending ? "Claw.Cua.stopping" : `Claw.Cua.phase.${runtime.phase}`)}
      </Tag>
      <Button size="small" disabled={busy || runtime.controlPending} onClick={() => void run(() => api.takeOver())}>{t("Claw.Cua.preview.takeover")}</Button>
      {!!runtime.stepCount && <span>{t("Claw.Cua.steps", { count: runtime.stepCount })}</span>}
      {runtime.phase === "running" && <Button size="small" disabled={busy || runtime.controlPending} onClick={() => void run(() => api.pause())}>{t("Claw.Cua.pause")}</Button>}
      {runtime.phase === "paused" && <Button size="small" disabled={busy || runtime.controlPending} onClick={() => void run(() => api.resume())}>{t("Claw.Cua.resume")}</Button>}
      {["running", "paused", "failed"].includes(runtime.phase) && <Button danger size="small" onClick={() => void run(() => api.stop())}>{t("Claw.Cua.stop")}</Button>}
      {["failed", "stopped"].includes(runtime.phase) && <Button size="small" disabled={busy || runtime.controlPending} onClick={() => void run(() => api.recover())}>{t("Claw.Cua.recover")}</Button>}
      {runtime.phase === "completed" && <Button size="small" onClick={() => void run(async () => {
        const result = await api.clearHistory(); accept(await api.getRuntime()); return result;
      })}>{t("Claw.Cua.dismiss")}</Button>}
    </Space>
    {runtime.reason === "userTakingControl" && <div style={{ fontSize: 12, marginTop: 6 }}>{t("Claw.Cua.preview.legacyTakeover")}</div>}
    <div style={{ marginTop: 6 }}>{runtime.scope?.kind === "window"
      ? `${t("Claw.Cua.scope.window")}: ${runtime.scope.label || t("Claw.Cua.scope.choose")}` : t("Claw.Cua.scope.desktop")}</div>
    {currentStep && <div style={{ marginTop: 6 }}>
      {t("Claw.Cua.latestAction")}: {t(`Claw.Cua.action.${actionKind(currentStep.tool)}`)} · {t(`Claw.Cua.outcome.${currentStep.outcome}`)}
    </div>}
    {reason && !runtime.controlPending && <div style={{ marginTop: 6 }}>{reason}</div>}
    {runtime.phase === "running" && runtime.needsObservation && <div>{t("Claw.Cua.observeFirst")}</div>}
    {runtime.phase === "completed" && <div>{t(runtime.resultObserved ? "Claw.Cua.reviewResult" : "Claw.Cua.unobservedResult")}</div>}
    {runtime.phase === "running" && <div style={{ fontSize: 12, marginTop: 4 }}>
      {t(runtime.shortcutAvailable ? "Claw.Cua.shortcut" : "Claw.Cua.shortcutUnavailable")}
    </div>}
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
