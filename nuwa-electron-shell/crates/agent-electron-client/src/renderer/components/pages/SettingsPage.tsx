/**
 * 设置页面（商业版行式重构：分组行列表 + 行内即点即存）
 *
 * 功能：
 * - 服务（服务域名、工作区目录）
 * - 系统（开机自启、本地化加速、主题）
 * - 目录（应用数据、日志）
 *
 * 交互语义（与旧「表单编辑解锁」版对齐，仅范式变化）：
 * - 服务域名：行内提交 → 确认弹窗 → configureServerHost 事务（清 token→停服→写库→刷新回环网关）
 * - 工作区：行内提交保存 step1_config
 */

import React, { useState, useEffect, useCallback, Suspense } from "react";
import {
  AutoComplete,
  Button,
  Space,
  Input,
  Select,
  Spin,
  Switch,
  message,
  Modal,
} from "antd";
import {
  APP_DISPLAY_NAME,
  APP_DATA_DIR_NAME,
  DEFAULT_SERVER_HOST,
  I18N_KEYS,
  TEST_SERVER_HOST,
} from "@shared/constants";
import { FEATURES } from "@shared/featureFlags";
import { ComputerUseSettings } from "../../features/computer-use";
import { LocalFilesSettings } from "../../features/local-files";
import { MessageSoundSettings } from "../settings/MessageSoundSettings";
import { setupService, type Step1Config } from "../../services/core/setup";
import {
  modifyWorkspaceDir,
  openWorkspaceDir,
} from "../../services/core/workspaceDir";
import { t } from "../../services/core/i18n";

import styles from "../../styles/components/SettingsPage.module.css";
import { useTheme, type ThemeMode } from "../../App";

// Dev tools: 开发模式或 beta 通道展示（stable 正式版不展示）。
// 必须无条件 lazy import：打包后 import.meta.env.DEV 恒为 false，按它条件加载
// 会让 beta 包的 bundle 里没有这个组件，运行时再判定也加载不到。
const UPDATE_CHANNEL_SETTING_KEY = "update_channel";
const DevToolsPanel = React.lazy(() => import("../dev/DevToolsPanel"));

/** 「允许锁屏运行」档位（与 shared/types/electron.d.ts PowerPolicyMode 对齐） */
type PowerPolicyMode = "off" | "keepAwake" | "keepDisplayOn";
// 行式列表的单行：左标签+描述、右控件
function SettingsRow(props: {
  label: React.ReactNode;
  desc?: React.ReactNode;
  descMono?: boolean;
  control?: React.ReactNode;
}) {
  const { label, desc, descMono, control } = props;
  return (
    <div className={styles.row}>
      <div className={styles.rowInfo}>
        <div className={styles.rowLabel}>{label}</div>
        {desc != null && (
          <div
            className={
              descMono
                ? `${styles.rowDesc} ${styles.rowDescMono}`
                : styles.rowDesc
            }
          >
            {desc}
          </div>
        )}
      </div>
      {control != null && <div className={styles.rowControl}>{control}</div>}
    </div>
  );
}

export default function SettingsPage({ onOpenAuthorization }: { onOpenAuthorization?: () => void } = {}) {
  const isMacPlatform = /mac/i.test(navigator.platform);

  // 主题
  const { themeMode, setThemeMode } = useTheme();

  // 服务配置（config 为已保存值；draft 为行内未提交输入）
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [config, setConfig] = useState<Step1Config | null>(null);
  const [hostDraft, setHostDraft] = useState<string | null>(null);
  // 系统设置
  const [autolaunchEnabled, setAutolaunchEnabled] = useState(false);
  const [autolaunchLoading, setAutolaunchLoading] = useState(false);
  const [logDir, setLogDir] = useState("");
  // 开发工具区可见性：开发构建立即可见；beta 通道包需读 update_channel 后置 true，
  // stable 正式包保持 false（读取失败也按 stable 处理，避免误暴露）。
  const [devToolsVisible, setDevToolsVisible] = useState(
    () => import.meta.env.DEV,
  );

  // 本地化加速（即点即存）：映射 nuwaxLoadMode → 保存后重启生效
  const [loopbackEnabled, setLoopbackEnabled] = useState(false);
  const [loopbackApplying, setLoopbackApplying] = useState(false);
  // 网关运行时真值（nuwax.loopback 键）：两种模式界面同貌，用户无法感知 webview
  // 换没换加载源（2026-09-18 提测反馈「关闭后没变化」）——把实际加载源亮出来
  const [loopbackRuntime, setLoopbackRuntime] = useState<{
    enabled?: boolean;
    origin?: string | null;
  } | null>(null);
  const loopbackSourceText = (
    rt: { enabled?: boolean; origin?: string | null } | null,
  ) =>
    rt?.enabled && rt.origin
      ? t("Claw.Settings.service.loopbackSource.gateway", {
          origin: rt.origin,
        })
      : t("Claw.Settings.service.loopbackSource.direct", {
          host: config?.serverHost || "—",
        });

  // 休眠控制（即点即存）：锁屏/窗口隐藏时暂停 webview 后台轮询，壳侧即时生效
  const [dormancyEnabled, setDormancyEnabled] = useState(true);
  const [dormancyApplying, setDormancyApplying] = useState(false);

  // 允许锁屏运行（即点即存）：电源保活档位，壳侧 powerSaveBlocker 即时生效
  const [powerPolicyMode, setPowerPolicyMode] = useState<PowerPolicyMode>("off");
  const [powerPolicyApplying, setPowerPolicyApplying] = useState(false);

  // Computer Use 设置区块（经特性公开入口渲染；未注册时整组隐藏）
  const [registeredFeatures, setRegisteredFeatures] = useState<string[]>([]);

  // 工作区目录行展示源：保存后即时跟随
  const workspaceDir = config?.workspaceDir ?? "";

  // ========== 加载服务配置 ==========
  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const loaded = await setupService.getStep1Config();
      setConfig(loaded);
      setLoopbackEnabled((loaded.nuwaxLoadMode ?? "direct") === "gateway");
    } catch (error) {
      console.error("Failed to load config:", error);
      message.error(t(I18N_KEYS.Toast.ERROR.LOAD_FAILED));
    } finally {
      setLoading(false);
    }
  }, []);

  // ========== 加载系统设置 ==========
  const loadSystemSettings = useCallback(async () => {
    try {
      const enabled = await window.electronAPI?.autolaunch?.get();
      setAutolaunchEnabled(enabled ?? false);
    } catch (error) {
      console.error("Failed to load autolaunch status:", error);
    }
    try {
      const dir = await window.electronAPI?.log?.getDir();
      setLogDir(dir || "");
    } catch (error) {
      console.error("Failed to load log directory:", error);
    }
    try {
      const dormancy = (await window.electronAPI?.settings?.get(
        "nuwax.dormancy",
      )) as { enabled?: unknown } | null;
      setDormancyEnabled(
        typeof dormancy?.enabled === "boolean" ? dormancy.enabled : true,
      );
    } catch (error) {
      console.error("Failed to load dormancy setting:", error);
    }
    try {
      const mode = await window.electronAPI?.powerPolicy?.get();
      if (mode) setPowerPolicyMode(mode);
    } catch (error) {
      console.error("Failed to load power policy:", error);
    }
    try {
      const rt = (await window.electronAPI?.settings?.get(
        "nuwax.loopback",
      )) as { enabled?: boolean; origin?: string | null } | null;
      setLoopbackRuntime(rt ?? null);
    } catch (error) {
      console.error("Failed to load loopback runtime state:", error);
    }
  }, []);

  useEffect(() => {
    void window.electronAPI?.features
      ?.registered?.()
      .then((ids) => setRegisteredFeatures(ids ?? []))
      .catch(() => setRegisteredFeatures([]));
  }, []);

  useEffect(() => {
    if (import.meta.env.DEV) return; // 开发模式已默认可见
    let active = true;
    void window.electronAPI?.settings
      ?.get(UPDATE_CHANNEL_SETTING_KEY)
      .then((saved) => {
        // 旧版本未写过该键，按 stable 处理（与 AboutPage 一致）
        if (active && saved === "beta") setDevToolsVisible(true);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    loadConfig();
    loadSystemSettings();

    // 监听来自托盘等外部修改的自启动状态变化
    const handleAutolaunchChanged = (enabled: boolean) => {
      setAutolaunchEnabled(enabled);
    };
    window.electronAPI?.on(
      "autolaunch:changed",
      handleAutolaunchChanged as any,
    );
    return () => {
      window.electronAPI?.off(
        "autolaunch:changed",
        handleAutolaunchChanged as any,
      );
    };
  }, [loadConfig, loadSystemSettings]);

  // ========== 服务域名：行内提交 → 确认 → configureServerHost 事务 ==========
  // 协议归一：支持带 http(s)://，未含默认补 https://
  //（与登录域/lanproxy 探针的后端域解析同式，见 loopback 设计文档 §6）
  const normalizeHost = (raw: string) => {
    const host = raw.trim().replace(/\/+$/, "");
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(host) ? host : `https://${host}`;
  };

  const commitHost = () => {
    const draft = hostDraft;
    if (draft == null) return;
    setHostDraft(null);
    const saved = config?.serverHost ?? "";
    const next = normalizeHost(draft);
    if (!next || next === saved) return;
    Modal.confirm({
      title: t("Claw.Settings.messages.switchDomainTitle"),
      // 换域副作用大（清 token→停服→切网关→强制重登），确认弹窗须明示改前/改后
      // 域名与后果，避免用户误改后不知改成了什么（2026-09-15 用户反馈）
      content: (
        <div>
          <div className={styles.switchDomainDiff}>
            <span className={styles.switchDomainLabel}>
              {t("Claw.Settings.messages.switchDomainCurrent")}
            </span>
            <span className={styles.switchDomainValue}>{saved || "—"}</span>
            <span className={styles.switchDomainArrow}>↓</span>
            <span className={styles.switchDomainLabel}>
              {t("Claw.Settings.messages.switchDomainNext")}
            </span>
            <span className={styles.switchDomainValueNext}>{next}</span>
          </div>
          <div className={styles.switchDomainWarn}>
            {t("Claw.Settings.messages.switchDomainWarn")}
          </div>
        </div>
      ),
      okText: t("Claw.Settings.saveConfig.save"),
      cancelText: t("Claw.Settings.saveConfig.cancel"),
      onOk: async () => {
        setSaving(true);
        try {
          const switched =
            await window.electronAPI!.services.configureServerHost(next);
          if (!switched.success)
            throw new Error(switched.error || "Domain switch failed");
          const latest = await setupService.getStep1Config();
          await setupService.saveStep1Config({
            ...latest,
            serverHost: switched.serverHost!,
          });
          setConfig({ ...latest, serverHost: switched.serverHost! });
          message.success(t(I18N_KEYS.Toast.SUCCESS.CONFIG_SAVED));
        } catch (error) {
          console.error("Failed to switch server host:", error);
          message.error(t(I18N_KEYS.Toast.ERROR.CONFIG_SAVE_FAILED));
        } finally {
          setSaving(false);
        }
      },
    });
  };

  // ========== 工作区目录：修改 / 打开（动作实现收口 services/core/workspaceDir，
  // 应用菜单「文件 → 更改/打开工作空间目录」共用同一实现） ==========
  const handleModifyWorkspace = async () => {
    setSaving(true);
    try {
      const changed = await modifyWorkspaceDir();
      if (changed) {
        const latest = await setupService.getStep1Config();
        setConfig(latest);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleOpenWorkspaceDir = async () => {
    await openWorkspaceDir();
  };

  // ========== 本地化加速 ==========
  const handleLoopbackChange = async (checked: boolean) => {
    setLoopbackApplying(true);
    try {
      const existing = await setupService.getStep1Config();
      await setupService.saveStep1Config({
        ...existing,
        nuwaxLoadMode: checked ? "gateway" : "direct",
      });
      // 网关随配置即时刷新（不依赖登录态）：运行时键变化会广播
      // nuwax:loopback-changed，webview 自动重载换形态。不能走 restartAll——
      // 商业版它被登录门禁拦在网关刷新之前，未登录时切换完全无效且失败被
      // 静默（2026-09-18 提测：开关后 webview 不重载）。
      const refreshed =
        await window.electronAPI?.services?.refreshLoopbackGateway?.();
      if (refreshed && refreshed.success === false)
        throw new Error(refreshed.error || "refreshLoopbackGateway failed");
      setLoopbackEnabled(checked);
      // 切换结果以运行时键回读为准（而非假定 checked 落地）——webview 已随
      // loopback-changed 重载，行文案与提示都指向实际加载源，肉眼可验
      const rt = (await window.electronAPI?.settings?.get(
        "nuwax.loopback",
      )) as { enabled?: boolean; origin?: string | null } | null;
      setLoopbackRuntime(rt ?? null);
      message.success(
        `${t(I18N_KEYS.Toast.SUCCESS.CONFIG_SAVED)}，${loopbackSourceText(rt)}`,
      );
    } catch {
      // 失败必须可见且状态不落定——静默会让用户误以为已生效
      message.error(t(I18N_KEYS.Toast.ERROR.CONFIG_SAVE_FAILED));
    } finally {
      setLoopbackApplying(false);
    }
  };

  // ========== 休眠控制：开关即时生效（壳 hostActivity 按状态迁移时点读库） ==========
  const handleDormancyChange = async (checked: boolean) => {
    setDormancyApplying(true);
    try {
      await window.electronAPI?.settings?.set("nuwax.dormancy", {
        enabled: checked,
      });
      setDormancyEnabled(checked);
    } catch {
      // 失败必须可见且状态不落定——静默会让用户误以为已生效
      message.error(t("Claw.Settings.messages.settingFailed"));
    } finally {
      setDormancyApplying(false);
    }
  };

  // ========== 允许锁屏运行：下拉即点即存（壳 powerPolicy 服务即时持有/释放断言） ==========
  const handlePowerPolicyChange = async (mode: PowerPolicyMode) => {
    setPowerPolicyApplying(true);
    try {
      await window.electronAPI?.powerPolicy?.setMode(mode);
      setPowerPolicyMode(mode);
    } catch {
      // 失败必须可见且状态不落定——静默会让用户误以为已生效
      message.error(t("Claw.Settings.messages.settingFailed"));
    } finally {
      setPowerPolicyApplying(false);
    }
  };

  // ========== 系统设置操作 ==========
  const handleAutolaunchChange = async (enabled: boolean) => {
    setAutolaunchLoading(true);
    try {
      const result = await window.electronAPI?.autolaunch?.set(enabled);
      if (result?.success) {
        setAutolaunchEnabled(enabled);
        message.success(
          enabled
            ? t("Claw.Settings.messages.autoLaunchEnabled")
            : t("Claw.Settings.messages.autoLaunchDisabled"),
        );
      } else {
        message.error(
          result?.error || t("Claw.Settings.messages.settingFailed"),
        );
      }
    } catch (error) {
      message.error(t(I18N_KEYS.Toast.ERROR.OPEN_SETTINGS_FAILED));
    } finally {
      setAutolaunchLoading(false);
    }
  };

  const handleOpenLogDir = async () => {
    try {
      await window.electronAPI?.log?.openDir();
    } catch {
      message.error(t(I18N_KEYS.Toast.ERROR.OPEN_LOGS_FAILED));
    }
  };

  if (loading) {
    return (
      <div style={{ textAlign: "center", padding: 40 }}>
        <Spin size="small" />
      </div>
    );
  }

  const hostValue = hostDraft ?? config?.serverHost ?? "";

  return (
    <div className={styles.page}>
      {/* 服务 */}
      <div className={styles.group}>
        <div className={styles.groupTitle}>
          {t("Claw.Settings.group.service")}
        </div>
        <div className={styles.groupCard}>
          <SettingsRow
            label={t("Claw.Settings.service.serverHost")}
            desc={t("Claw.Settings.service.serverHostDesc")}
            control={
              // AutoComplete 无 onPressEnter prop：回车经外层 onKeyDown 冒泡提交；
              // commitHost 幂等（draft 即清），与 blur 双触发安全
              <span
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitHost();
                }}
              >
                <AutoComplete
                  style={{ width: 260 }}
                  value={hostValue}
                  // 预置建议：默认域 + 测试域去重（测试期默认域即测试环境，
                  // 恢复正式默认后两项并存，方便来回切换）
                  options={[...new Set([DEFAULT_SERVER_HOST, TEST_SERVER_HOST])].map(
                    (value) => ({ value }),
                  )}
                  placeholder={t(
                    "Claw.Settings.service.serverHostPlaceholder",
                  )}
                  disabled={saving}
                  onChange={(value) => setHostDraft(value)}
                  onBlur={commitHost}
                />
              </span>
            }
          />
          <SettingsRow
            label={t("Claw.Settings.workspace.title")}
            desc={workspaceDir || t("Claw.Settings.system.notSet")}
            descMono
            control={
              <>
                <Button
                  size="small"
                  onClick={handleModifyWorkspace}
                  disabled={saving}
                >
                  {t("Claw.Settings.service.workspaceModify")}
                </Button>
                <Button
                  size="small"
                  onClick={handleOpenWorkspaceDir}
                  disabled={!workspaceDir}
                >
                  {t("Claw.Settings.system.open")}
                </Button>
              </>
            }
          />
        </div>
      </div>

      {/* 系统 */}
      <div className={styles.group}>
        <div className={styles.groupTitle}>
          {t("Claw.Settings.system.title")}
        </div>
        <div className={styles.groupCard}>
          <MessageSoundSettings t={t} Row={SettingsRow} />
          <SettingsRow
            label={t("Claw.Settings.system.autoLaunch")}
            desc={t("Claw.Settings.system.autoLaunchDesc", {
              appName: APP_DISPLAY_NAME,
            })}
            control={
              <Switch
                checked={autolaunchEnabled}
                onChange={handleAutolaunchChange}
                loading={autolaunchLoading}
              />
            }
          />

          {/* 本地化加速（loopback 网关同源加载；服务域名在「服务」区块） */}
          <SettingsRow
            label={t("Claw.Settings.service.loopback")}
            desc={`${t("Claw.Settings.service.loopbackDesc")} ${loopbackSourceText(loopbackRuntime)}`}
            control={
              <Switch
                checked={loopbackEnabled}
                onChange={handleLoopbackChange}
                loading={loopbackApplying}
              />
            }
          />

          <LocalFilesSettings t={t} Row={SettingsRow} />

          {/* 休眠控制：不可见时暂停 webview 后台轮询，恢复可见立即补拉 */}
          <SettingsRow
            label={t("Claw.Settings.system.dormancy")}
            desc={t("Claw.Settings.system.dormancyDesc")}
            control={
              <Switch
                checked={dormancyEnabled}
                onChange={handleDormancyChange}
                loading={dormancyApplying}
              />
            }
          />

          {/* 允许锁屏运行：电源保活档位，保障远程控制与后台 Agent 任务持续执行 */}
          <SettingsRow
            label={t("Claw.Settings.system.powerPolicy")}
            desc={t("Claw.Settings.system.powerPolicyDesc")}
            control={
              <Select
                style={{ width: 140 }}
                value={powerPolicyMode}
                onChange={(value) =>
                  handlePowerPolicyChange(value as PowerPolicyMode)
                }
                options={[
                  {
                    value: "off",
                    label: t("Claw.Settings.system.powerPolicyOff"),
                  },
                  {
                    value: "keepAwake",
                    label: t("Claw.Settings.system.powerPolicyKeepAwake"),
                  },
                  {
                    value: "keepDisplayOn",
                    label: t("Claw.Settings.system.powerPolicyKeepDisplayOn"),
                  },
                ]}
              />
            }
          />

          {/* 客户端自身的系统授权（屏幕录制、全磁盘访问等）统一在「授权」页查看和开启，这里只给入口 */}
          {isMacPlatform && onOpenAuthorization && (
            <SettingsRow
              label={t("Claw.Settings.systemAuthorization.label")}
              desc={t("Claw.Settings.systemAuthorization.desc")}
              control={
                <Button size="small" onClick={onOpenAuthorization}>
                  {t("Claw.Settings.systemAuthorization.open")}
                </Button>
              }
            />
          )}

          {/* 主题设置（暗黑模式经环境变量关闭时恒浅色，外观项无意义随之隐藏） */}
          {FEATURES.DARK_THEME && (
            <SettingsRow
              label={t("Claw.Settings.system.theme")}
              desc={t("Claw.Settings.system.themeDesc")}
              control={
                <Select
                  style={{ width: 140 }}
                  value={themeMode}
                  onChange={(value) => setThemeMode(value as ThemeMode)}
                  options={[
                    {
                      value: "system",
                      label: t("Claw.Settings.system.themeSystem"),
                    },
                    {
                      value: "light",
                      label: t("Claw.Settings.system.themeLight"),
                    },
                    {
                      value: "dark",
                      label: t("Claw.Settings.system.themeDark"),
                    },
                  ]}
                />
              }
            />
          )}
        </div>
      </div>

      {/* Computer Use（特性公开入口渲染；未注册时整组隐藏） */}
      {registeredFeatures.includes("computer-use") && (
        <div className={styles.group}>
          <div className={styles.groupTitle}>
            {t("Claw.Settings.computerUse.title")}
          </div>
          <div className={styles.groupCard}>
            <ComputerUseSettings
              t={t}
              Row={SettingsRow}
              api={window.electronAPI?.computerUse}
            />
          </div>
        </div>
      )}

      {/* 目录 */}
      <div className={styles.group}>
        <div className={styles.groupTitle}>
          {t("Claw.Settings.group.directories")}
        </div>
        <div className={styles.groupCard}>
          <SettingsRow
            label={t("Claw.Settings.system.appDataDir")}
            desc={`~/${APP_DATA_DIR_NAME}`}
            descMono
          />
          <SettingsRow
            label={t("Claw.Settings.system.logDir")}
            desc={logDir || t("Claw.Settings.system.loading")}
            descMono
            control={
              <Button size="small" onClick={handleOpenLogDir}>
                {t("Claw.Settings.system.open")}
              </Button>
            }
          />
        </div>
      </div>

      {/* 开发工具 - 开发模式或 beta 通道 */}
      {devToolsVisible && (
        <div className={styles.group}>
          <div className={styles.groupCard}>
            <Suspense fallback={<Spin size="small" />}>
              <DevToolsPanel />
            </Suspense>
          </div>
        </div>
      )}
    </div>
  );
}
