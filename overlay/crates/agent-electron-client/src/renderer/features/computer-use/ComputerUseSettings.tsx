/**
 * Computer Use 设置区块（渲染进程特性公开入口内容）。
 * 翻译函数、行组件与桥对象由调用方注入；不 import 客户端 i18n/样式/状态。
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Button, Input, Modal, Select, Space, Switch, message } from "antd";
import type { ComputerUseAPI, ComputerUseStatus } from "@shared/features/computer-use/contract";
import { CuaSettingsRows } from "./CuaControls";
import styles from "./ComputerUseSettings.module.css";

type T = (key: string, ...args: any[]) => string;
type Row = (props: { label: React.ReactNode; desc?: React.ReactNode; control?: React.ReactNode }) => React.ReactElement;

// 权限状态点：true 绿✓ / false 红✗ / null 灰?（未知，尚未探测）
function PermDot(props: { ok: boolean | null | undefined }) {
  const { ok } = props;
  const color = ok == null ? "#999" : ok ? "#52c41a" : "#ff4d4f";
  const label = ok == null ? "?" : ok ? "✓" : "✗";
  return <span style={{ color, marginLeft: 4, fontWeight: 600 }}>{label}</span>;
}

function cuaErrorText(t: T, error?: string): string {
  const known = new Set([
    "permissionsRequired", "permissionHostFailed", "timeout", "daemonNotReady",
    "bundledNotFound", "helperNotInstalled", "helperStillRunning", "databaseNotReady",
    "disableFailed", "policyNotActive", "helperIdentityUnverified",
  ]);
  return t("Claw.Settings.computerUse.errors." + (error && known.has(error) ? error : "generic"));
}

/** Image endpoint test errors; HTTP status codes are shown as-is, since they are what users can look up. */
function vlmTestErrorText(t: T, error?: string): string {
  if (error?.startsWith("HTTP ")) return error;
  const known = new Set([
    "vlmNotConfigured", "answerTruncated", "visionVerificationFailed", "requestFailed",
    "timeout", "invalidResponse", "invalidConfig", "secureStorageUnavailable",
  ]);
  return t("Claw.Settings.computerUse.vlmErrors." + (error && known.has(error) ? error : "generic"));
}

export function ComputerUseSettings({ t, Row, api }: { t: T; Row: Row; api?: ComputerUseAPI }) {
  // TCC 授权引导仅 mac（Windows 无辅助功能/屏幕录制 per-app 授权，UIA/截屏开箱即用）
  const authorizationGeneration = useRef(0);
  useEffect(() => () => { authorizationGeneration.current++; }, []);
  const isMacPlatform = /mac/i.test(navigator.platform);
  const [cuaStatus, setCuaStatus] = useState<ComputerUseStatus | null>(null);
  const [cuaEnablePendingPermission, setCuaEnablePendingPermission] = useState(false);
  const [cuaApplying, setCuaApplying] = useState(false);
  const [cuaInstalling, setCuaInstalling] = useState(false);
  const [cuaPermChecking, setCuaPermChecking] = useState(false);
  const [cuaVlm, setCuaVlm] = useState<{
    baseUrl: string;
    model: string;
    apiKey: string;
    hasApiKey?: boolean;
  } | null>(null);
  const [cuaVlmTesting, setCuaVlmTesting] = useState(false);
  const [installedApps, setInstalledApps] = useState<{ id: string; label: string }[]>([]);
  const [screenshots, setScreenshots] = useState<string[]>([]);

  // 视觉模型配置：行内即点即存（与端口/域名同范式）
  const commitVlm = async (patch: {
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    clearApiKey?: boolean;
  }) => {
    try {
      const result = await api!.setVlmConfig(patch);
      if (!result.success) throw new Error("configSaveFailed");
      const saved = await api!.getVlmConfig();
      setCuaVlm((value) => value ? { ...value, hasApiKey: saved.hasApiKey,
        apiKey: patch.clearApiKey || value.apiKey === patch.apiKey ? "" : value.apiKey } : value);
      return true;
    } catch {
      message.error(t("Claw.Settings.computerUse.errors.generic"));
      return false;
    }
  };

  const handleVlmTest = async () => {
    // 先落当前草稿再测，避免「看起来填了但没存」的假成功
    if (cuaVlm && !(await commitVlm(cuaVlm))) return;
    setCuaVlmTesting(true);
    try {
      const r = await api!.testVlm();
      if (r.success) {
        message.success(
          t("Claw.Settings.computerUse.vlmTestOk", { ms: r.latencyMs ?? "?" }),
        );
      } else {
        message.error(
          t("Claw.Settings.computerUse.vlmTestFail", {
            err: vlmTestErrorText(t, r.error),
          }),
        );
      }
    } finally {
      setCuaVlmTesting(false);
    }
  };

  // ========== 状态加载 / 开关 / 授权引导 ==========
  const loadCuaStatus = useCallback(async () => {
    if (!api) return;
    try {
      api
        .getVlmConfig()
        .then((v) => setCuaVlm(v))
        .catch(() => undefined);
      const s = await api.getStatus();
      setCuaStatus(s);
      setCuaEnablePendingPermission(s.consentPending === true);
      void api.listInstalledApps?.().then(setInstalledApps).catch(() => undefined);
      void api.listScreenshots?.().then(setScreenshots).catch(() => undefined);
    } catch (error) {
      console.error("Failed to load computer use status:", error);
    }
  }, [api]);

  const handleCuaChange = async (checked: boolean) => {
    const generation = ++authorizationGeneration.current;
    if (!checked) setCuaPermChecking(false);
    if (checked && !cuaEnablePendingPermission && !cuaStatus?.consentPending) {
      const accepted = await new Promise<boolean>((resolve) => {
        Modal.confirm({
          title: t("Claw.Settings.computerUse.consentTitle"),
          content: t("Claw.Settings.computerUse.consentDescription"),
          okText: t("Claw.Settings.computerUse.consentAccept"),
          cancelText: t("Claw.Settings.computerUse.consentCancel"),
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        });
      });
      if (!accepted || generation !== authorizationGeneration.current) return;
    } else if (!checked) {
      setCuaEnablePendingPermission(false);
    }
    setCuaApplying(true);
    try {
      const r = await api!.setEnabled(checked);
      if (generation !== authorizationGeneration.current) return;
      if (r.status) {
        setCuaStatus(r.status);
        setCuaEnablePendingPermission(r.status.consentPending === true);
      }
      if (!r.success) {
        message.error(cuaErrorText(t, r.error));
        return;
      }
      setCuaEnablePendingPermission(false);
      message.success(t("Claw.Toast.Success.configSaved"));
    } catch {
      message.error(t("Claw.Toast.Error.configSaveFailed"));
    } finally {
      if (generation === authorizationGeneration.current) setCuaApplying(false);
    }
  };

  // 授权动作兼复查：已授权时立即返回且不再弹窗（见 computerUse 服务契约）
  const handleCuaRequestPermissions = async () => {
    const generation = ++authorizationGeneration.current;
    setCuaPermChecking(true);
    try {
      const r = await api!.requestPermissions();
      if (generation !== authorizationGeneration.current) return;
      setCuaStatus((prev) =>
        prev
          ? {
              ...prev,
              accessibility: r.accessibility ?? null,
              screenRecording: r.screenRecording ?? null,
            }
          : prev,
      );
      if (r.success && r.accessibility && r.screenRecording) {
        message.success(t("Claw.Settings.computerUse.permGranted"));
        if (cuaEnablePendingPermission || cuaStatus?.consentPending) {
          setCuaApplying(true);
          const enabled = await api!.setEnabled(true);
          if (generation !== authorizationGeneration.current) return;
          if (enabled.status) {
            setCuaStatus(enabled.status);
            setCuaEnablePendingPermission(enabled.status.consentPending === true);
          }
          if (enabled.success) {
            setCuaEnablePendingPermission(false);
            message.success(t("Claw.Toast.Success.configSaved"));
          } else {
            message.error(cuaErrorText(t, enabled.error));
          }
        }
      } else {
        message.info(t("Claw.Settings.computerUse.permPending"));
      }
    } catch {
      message.error(t("Claw.Toast.Error.loadFailed"));
    } finally {
      if (generation === authorizationGeneration.current) { setCuaPermChecking(false); setCuaApplying(false); }
    }
  };

  // 手动安装/升级入口；开启开关时也会自动执行，安装本身不请求系统权限。
  const handleCuaInstall = async () => {
    setCuaInstalling(true);
    try {
      const r = await api!.installHelper();
      if (!r.success) {
        message.error(cuaErrorText(t, r.error));
        return;
      }
      message.success(t("Claw.Settings.computerUse.installOk"));
      await loadCuaStatus();
    } catch {
      message.error(t("Claw.Toast.Error.loadFailed"));
    } finally {
      setCuaInstalling(false);
    }
  };

  useEffect(() => {
    loadCuaStatus();
    const refresh = () => {
      void api?.getStatus().then(setCuaStatus).catch(() => undefined);
    };
    window.electronAPI?.on("cua:runtime", refresh);
    window.addEventListener("focus", refresh);
    return () => { window.electronAPI?.off("cua:runtime", refresh); window.removeEventListener("focus", refresh); };
  }, [loadCuaStatus, api]);

  return (
    <>
      <Row
        label={t("Claw.Settings.computerUse.enable")}
        desc={
          <span>
            {t("Claw.Settings.computerUse.desc")}
            {cuaStatus && (
              <span style={{ marginLeft: 8, whiteSpace: "nowrap" }}>
                {cuaStatus.consentPending || cuaStatus.error === "permissionsRequired"
                  ? `● ${t("Claw.Settings.computerUse.stateAwaitingPermission")}`
                  : !cuaStatus.enabled
                  ? `● ${t("Claw.Settings.computerUse.stateOff")}`
                  : cuaStatus.installed
                    ? cuaStatus.running
                      ? `● ${t("Claw.Settings.computerUse.stateRunning")}`
                      : `● ${t("Claw.Settings.computerUse.stateIdle")}`
                    : `● ${t("Claw.Settings.computerUse.stateNotInstalled")}`}
              </span>
            )}
          </span>
        }
        control={
          <Switch
            checked={!!cuaStatus?.enabled}
            onChange={handleCuaChange}
            loading={cuaApplying}
            disabled={!cuaStatus?.installed && !cuaStatus?.installable}
          />
        }
      />
      <Row
        label={t("Claw.Settings.computerUse.agentCursor")}
        desc={t("Claw.Settings.computerUse.agentCursorDesc")}
        control={
          <Switch
            checked={cuaStatus?.agentCursor !== false}
            disabled={!api?.setAgentCursor}
            onChange={(checked) => {
              void api?.setAgentCursor?.(checked).then((r) => {
                if (r?.status) setCuaStatus(r.status);
                else if (r?.success === false) message.error(cuaErrorText(t, r.error));
              }).catch(() => message.error(t("Claw.Settings.computerUse.errors.generic")));
            }}
          />
        }
      />
      <Row
        label={t("Claw.Settings.computerUse.authMode")}
        desc={t("Claw.Settings.computerUse.authModeDesc")}
        control={
          <Select
            size="small"
            style={{ width: 200 }}
            value={cuaStatus?.authMode === "ask" ? "ask" : "unrestricted"}
            options={[
              { value: "unrestricted", label: t("Claw.Settings.computerUse.authUnrestricted") },
              { value: "ask", label: t("Claw.Settings.computerUse.authAsk") },
            ]}
            disabled={!api?.setAuthMode}
            onChange={(mode) => {
              void api?.setAuthMode?.(mode).then((r) => {
                if (r?.status) setCuaStatus(r.status);
                else if (r?.success === false) message.error(cuaErrorText(t, r.error));
              }).catch(() => message.error(t("Claw.Settings.computerUse.errors.generic")));
            }}
          />
        }
      />
      <Row
        label={t("Claw.Settings.computerUse.blacklist")}
        desc={t("Claw.Settings.computerUse.blacklistDesc")}
        control={
          <Select
            mode="tags"
            size="small"
            style={{ minWidth: 240, maxWidth: 360 }}
            value={cuaStatus?.blacklist ?? []}
            options={installedApps.map((app) => ({ value: app.label, label: app.label }))}
            placeholder={t("Claw.Settings.computerUse.blacklistPlaceholder")}
            disabled={!api?.setBlacklist}
            onChange={(apps) => {
              void api?.setBlacklist?.(apps).then((r) => {
                if (r?.status) setCuaStatus(r.status);
                else if (r?.success === false) message.error(cuaErrorText(t, r.error));
              }).catch(() => message.error(t("Claw.Settings.computerUse.errors.generic")));
            }}
          />
        }
      />
      <Row
        label={t("Claw.Settings.computerUse.privacy")}
        desc={<>
          {t("Claw.Settings.computerUse.privacyDesc", { path: cuaStatus?.screenshotHome || "~/.nuwax/computer-use" })}
          {!!screenshots.length && <span style={{ display: "block", marginTop: 4 }}>{t("Claw.Settings.computerUse.privacyFiles", { count: screenshots.length })}</span>}
          <span style={{ display: "block", marginTop: 4 }}>{t("Claw.Settings.computerUse.containerBoundary")}</span>
        </>}
      />
      {!cuaStatus?.installed && cuaStatus?.installable && (
        <Row
          label={t("Claw.Settings.computerUse.install")}
          desc={t("Claw.Settings.computerUse.installDesc")}
          control={
            <Button
              size="small"
              loading={cuaInstalling}
              onClick={handleCuaInstall}
            >
              {t("Claw.Settings.computerUse.installBtn")}
            </Button>
          }
        />
      )}
      {(cuaEnablePendingPermission || cuaStatus?.consentPending || cuaApplying || cuaPermChecking) && <Row
        label={t("Claw.Settings.computerUse.pendingTitle")}
        desc={t("Claw.Settings.computerUse.pendingDescription")}
        control={<Button size="small" onClick={() => void handleCuaChange(false)}>{t("Claw.Settings.computerUse.cancelPreparation")}</Button>}
      />}
      {isMacPlatform && (
        <Row
          label={t("Claw.Settings.computerUse.permissions")}
          desc={
            <span>
              {t("Claw.Settings.computerUse.permAx")}
              <PermDot ok={cuaStatus?.accessibility} />
              {" · "}
              {t("Claw.Settings.computerUse.permSr")}
              <PermDot ok={cuaStatus?.screenRecording} />
            </span>
          }
          control={
            <Button
              size="small"
              loading={cuaPermChecking}
              disabled={!cuaStatus?.installed}
              onClick={handleCuaRequestPermissions}
            >
              {t(cuaEnablePendingPermission || cuaStatus?.consentPending ? "Claw.Settings.computerUse.continueEnable" : "Claw.Settings.computerUse.requestPerm")}
            </Button>
          }
        />
      )}
      {cuaStatus?.enabled && (
        <CuaSettingsRows api={api} t={t} Row={Row} />
      )}
      <Row
        label={t("Claw.Settings.computerUse.taskModel")}
        desc={t("Claw.Settings.computerUse.taskModelDescription")}
      />
      <p className={styles.lockBehavior}>{t("Claw.Settings.computerUse.lockBehavior")}</p>
      <details className={styles.advancedDiagnostics}>
      <summary className={styles.advancedSummary}>{t("Claw.Settings.computerUse.advancedDiagnostics")}</summary>
      <Row
        label={t("Claw.Settings.computerUse.vlmModel")}
        desc={t("Claw.Settings.computerUse.vlmModelDesc")}
        control={
          <Input
            style={{ width: 200 }}
            placeholder="glm-4.5v"
            value={cuaVlm?.model ?? ""}
            disabled={!cuaVlm}
            onChange={(e) =>
              setCuaVlm((v) =>
                v ? { ...v, model: e.target.value } : v,
              )
            }
            onBlur={() =>
              cuaVlm && commitVlm({ model: cuaVlm.model })
            }
          />
        }
      />
      <Row
        label={t("Claw.Settings.computerUse.vlmBaseUrl")}
        desc={t("Claw.Settings.computerUse.vlmBaseUrlDesc")}
        control={
          <Input
            style={{ width: 280 }}
            value={cuaVlm?.baseUrl ?? ""}
            disabled={!cuaVlm}
            onChange={(e) =>
              setCuaVlm((v) =>
                v ? { ...v, baseUrl: e.target.value } : v,
              )
            }
            onBlur={() =>
              cuaVlm && commitVlm({ baseUrl: cuaVlm.baseUrl })
            }
          />
        }
      />
      <Row
        label={t("Claw.Settings.computerUse.vlmApiKey")}
        desc={t("Claw.Settings.computerUse.vlmApiKeyDesc")}
        control={
          <Space>
            <Input.Password
              placeholder={cuaVlm?.hasApiKey ? t("Claw.Cua.keySaved") : ""}
              style={{ width: 280 }}
              value={cuaVlm?.apiKey ?? ""}
              disabled={!cuaVlm}
              onChange={(e) =>
                setCuaVlm((v) =>
                  v ? { ...v, apiKey: e.target.value } : v,
                )
              }
              onBlur={() =>
                cuaVlm && commitVlm({ apiKey: cuaVlm.apiKey })
              }
            />
            <Button size="small" disabled={!cuaVlm?.hasApiKey} onClick={() => void commitVlm({ clearApiKey: true })}>
              {t("Claw.Cua.clearKey")}
            </Button>
          </Space>
        }
      />
      <Row
        label={t("Claw.Settings.computerUse.vlmTest")}
        desc={t("Claw.Settings.computerUse.vlmTestDesc")}
        control={
          <Button
            size="small"
            loading={cuaVlmTesting}
            onClick={handleVlmTest}
          >
            {t("Claw.Settings.computerUse.vlmTestBtn")}
          </Button>
        }
      />
      </details>
    </>
  );
}
