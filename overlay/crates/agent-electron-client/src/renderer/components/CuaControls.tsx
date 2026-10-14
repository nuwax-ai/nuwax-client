import React, { useEffect, useState } from "react";
import { Alert, Button, Select, Space, Tag, message, theme } from "antd";
import type { ComputerUseAPI } from "@shared/types/electron";
import type { CuaCheck, CuaRuntime, CuaWindow } from "@shared/types/cuaRuntime";

import { CUA_REASON_KEYS, actionKind } from "@shared/cuaPresentation";
const REASONS = new Set(CUA_REASON_KEYS);

export function CuaControls({ api, t, compact = false }: {
  api?: ComputerUseAPI;
  t: (key: string, ...args: any[]) => string;
  compact?: boolean;
}) {
  const { token } = theme.useToken();
  const [runtime, setRuntime] = useState<CuaRuntime | null>(null);
  const acceptRuntime = (state: CuaRuntime) => setRuntime((current) =>
    !current || state.revision >= current.revision ? state : current);
  const [busy, setBusy] = useState(false);
  const [checks, setChecks] = useState<CuaCheck[] | null>(null);
  const [windows, setWindows] = useState<CuaWindow[]>([]);
  useEffect(() => {
    if (!api?.getRuntime) return;
    let active = true;
    const refresh = () => { void api.getRuntime().then((state) => { if (active) acceptRuntime(state); }).catch(() => undefined); };
    const listener = (state: unknown) => { if (active && state) acceptRuntime(state as CuaRuntime); };
    refresh();
    window.electronAPI?.on("cua:runtime", listener);
    window.addEventListener("focus", refresh);
    return () => { active = false; window.removeEventListener("focus", refresh); window.electronAPI?.off("cua:runtime", listener); };
  }, [api]);
  if (!api?.getRuntime || !runtime || (compact && !runtime.taskId && runtime.phase !== "failed")) return null;

  const run = async (action: () => Promise<any>) => {
    setBusy(true);
    try {
      const result = await action();
      if (result?.runtime) acceptRuntime(result.runtime);
      if (result?.checks) setChecks(result.checks);
      if (result?.windows) setWindows(result.windows);
      if (result?.success === false && !result.cancelled) {
        message.error(t(`Claw.Cua.reason.${REASONS.has(result.error) ? result.error : "generic"}`));
      }
    } catch { message.error(t("Claw.Cua.reason.generic")); }
    finally { setBusy(false); }
  };
  const reason = runtime.reason ? t(`Claw.Cua.reason.${REASONS.has(runtime.reason) ? runtime.reason : "generic"}`) : null;
  const currentStep = runtime.steps.at(-1);
  const content = <>
    <Space wrap>
      <strong>{t("Claw.Cua.title")}</strong>
      <Tag color={runtime.phase === "running" ? "processing" : runtime.phase === "failed" ? "error" : "default"}>
        {t(runtime.controlPending ? "Claw.Cua.stopping" : `Claw.Cua.phase.${runtime.phase}`)}
      </Tag>
      {!!runtime.stepCount && <span>{t("Claw.Cua.steps", { count: runtime.stepCount })}</span>}
      {runtime.phase === "running" && <Button size="small" disabled={busy || runtime.controlPending} onClick={() => void run(() => api.pause())}>{t("Claw.Cua.pause")}</Button>}
      {runtime.phase === "paused" && <Button size="small" disabled={busy || runtime.controlPending} onClick={() => void run(() => api.resume())}>{t("Claw.Cua.resume")}</Button>}
      {["running", "paused", "failed"].includes(runtime.phase) && <Button danger size="small" onClick={() => void run(() => api.stop())}>{t("Claw.Cua.stop")}</Button>}
      {["failed", "stopped"].includes(runtime.phase) && <Button size="small" disabled={busy || runtime.controlPending} onClick={() => void run(() => api.recover())}>{t("Claw.Cua.recover")}</Button>}
      {runtime.phase === "completed" && <Button size="small" onClick={() => void run(async () => {
        const result = await api.clearHistory(); acceptRuntime(await api.getRuntime()); return result;
      })}>{t("Claw.Cua.dismiss")}</Button>}
    </Space>
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
    {!compact && <>
      <Space wrap style={{ marginTop: 10 }}>
        <Button disabled={busy || runtime.controlPending || ["running", "paused"].includes(runtime.phase)} onClick={() => void run(() => api.listWindows())}>{t("Claw.Cua.scope.refresh")}</Button>
        <Select aria-label={t("Claw.Cua.scope.choose")} style={{ width: 300, maxWidth: "100%" }}
          disabled={busy || runtime.controlPending || ["running", "paused"].includes(runtime.phase)}
          value={runtime.scope?.kind === "window" ? `${runtime.scope.pid}:${runtime.scope.windowId}` : "desktop"}
          options={[{ value: "desktop", label: t("Claw.Cua.scope.desktop") }, ...(runtime.scope?.kind === "window" && !windows.some((item) => `${item.pid}:${item.windowId}` === (runtime.scope?.kind === "window" ? `${runtime.scope.pid}:${runtime.scope.windowId}` : "")) ? [{ value: `${runtime.scope.pid}:${runtime.scope.windowId}`, label: runtime.scope.label || t("Claw.Cua.scope.choose") }] : []), ...windows.map((item) => ({ value: `${item.pid}:${item.windowId}`, label: item.label }))]}
          onChange={(value) => {
            if (value === "desktop") void run(() => api.setScope({ kind: "desktop" }));
            else { const target = windows.find((item) => `${item.pid}:${item.windowId}` === value); if (target) void run(() => api.setScope({ kind: "window", pid: target.pid, windowId: target.windowId })); }
          }} />
      </Space>
      <p>{t("Claw.Cua.scope.explanation")}</p>
      <p>{t("Claw.Cua.modelExplanation")}</p>
      <Space wrap>
        <Button loading={busy} onClick={() => void run(() => api.selfTest())}>{t("Claw.Cua.selfTest")}</Button>
        <Button onClick={() => void run(() => api.exportDiagnostics())}>{t("Claw.Cua.export")}</Button>
        <Button disabled={["running", "paused"].includes(runtime.phase)} onClick={() => void run(async () => {
          const result = await api.clearHistory(); acceptRuntime(await api.getRuntime()); return result;
        })}>{t("Claw.Cua.clear")}</Button>
      </Space>
      <p style={{ fontSize: 12 }}>{t("Claw.Cua.privacy")}</p>
      {!!runtime.steps.length && <details>
        <summary>{t("Claw.Cua.history")}</summary>
        <ol style={{ maxHeight: 180, overflow: "auto", paddingLeft: 28 }}>
          {runtime.steps.map((step) => <li key={step.sequence} value={step.sequence}>
            {t(`Claw.Cua.action.${actionKind(step.tool)}`)} · {t(`Claw.Cua.outcome.${step.outcome}`)}
            {step.durationMs !== undefined && ` · ${(step.durationMs / 1000).toFixed(1)} s`}
          </li>)}
        </ol>
      </details>}
      {checks && <div role="status">{checks.map((check) => <div key={check.name}>
        {t(`Claw.Cua.check.${check.name}`)}: {t(`Claw.Cua.check.${check.status}`)}
        {check.reason && ` — ${t(check.name === "model" ? "Claw.Cua.modelCheck" : `Claw.Cua.reason.${REASONS.has(check.reason) ? check.reason : "generic"}`)}`}
      </div>)}</div>}
    </>}
  </>;
  if (!compact) return <Alert type="info" message={content} style={{ marginBottom: 16 }} />;
  return <aside aria-label={t("Claw.Cua.title")} aria-live="polite" style={{
    position: "fixed", bottom: 20, left: "50%", transform: "translateX(-50%)", zIndex: 9999,
    width: "max-content", maxWidth: "calc(100% - 48px)", padding: "12px 16px", borderRadius: 12,
    background: token.colorBgElevated, color: token.colorText,
    boxShadow: "0 4px 24px #0003", border: "1px solid #8884",
  }}>{content}</aside>;
}
