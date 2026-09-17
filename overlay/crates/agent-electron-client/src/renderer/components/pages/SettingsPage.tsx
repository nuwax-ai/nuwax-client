/**
 * 设置页面（商业版行式重构：分组行列表 + 行内即点即存）
 *
 * 功能：
 * - 服务（服务域名、工作区目录）
 * - 高级（端口，默认折叠）
 * - 系统（开机自启、本地化加速、主题、语言）
 * - 目录（应用数据、日志）
 *
 * 交互语义（与旧「表单编辑解锁」版对齐，仅范式变化）：
 * - 服务域名：行内提交 → 确认弹窗 → configureServerHost 事务（清 token→停服→写库→刷新回环网关）
 * - 端口/工作区：行内提交保存 step1_config，提示需重启服务生效
 */

import React, { useState, useEffect, useCallback, Suspense } from "react";
import {
  AutoComplete,
  Button,
  InputNumber,
  Select,
  Spin,
  Switch,
  message,
  Modal,
} from "antd";
import { RightOutlined } from "@ant-design/icons";
import {
  APP_DISPLAY_NAME,
  APP_DATA_DIR_NAME,
  DEFAULT_SERVER_HOST,
  I18N_KEYS,
  TEST_SERVER_HOST,
} from "@shared/constants";
import { FEATURES } from "@shared/featureFlags";
import { setupService, type Step1Config } from "../../services/core/setup";
import {
  t,
  setCurrentLang,
  scheduleLangMapRefreshOnNextInit,
  fetchI18nLangList,
  prefetchLangMap,
  type I18nLangDto,
} from "../../services/core/i18n";

import styles from "../../styles/components/SettingsPage.module.css";
import { useTheme, useI18nLang, type ThemeMode } from "../../App";

// Dev tools: 仅开发模式加载
const IS_DEV = import.meta.env.DEV;
const DevToolsPanel = IS_DEV
  ? React.lazy(() => import("../dev/DevToolsPanel"))
  : null;

// 本地支持的语言选项（兜底用）
// 使用与后端一致的完整语言码格式（如 zh-cn），与 i18nLang 格式对齐
const LOCAL_LANG_OPTIONS = [
  { value: "en-us", label: t("Claw.Settings.system.langEnglish") },
  { value: "zh-cn", label: t("Claw.Settings.system.langChinese") },
  { value: "zh-tw", label: t("Claw.Settings.system.langChineseTW") },
  { value: "zh-hk", label: t("Claw.Settings.system.langChineseHK") },
];

type PortKey = "fileServerPort" | "agentPort" | "ttydPort";
const PORT_LABELS: Record<PortKey, string> = {
  fileServerPort: "Claw.Settings.saveConfig.fileServerPort",
  agentPort: "Claw.Settings.saveConfig.agentPort",
  ttydPort: "Claw.Settings.saveConfig.ttydPort",
};

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

export default function SettingsPage() {
  // 主题
  const { themeMode, setThemeMode } = useTheme();

  // 服务配置（config 为已保存值；draft 为行内未提交输入）
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [config, setConfig] = useState<Step1Config | null>(null);
  const [hostDraft, setHostDraft] = useState<string | null>(null);
  const [portDrafts, setPortDrafts] = useState<
    Partial<Record<PortKey, number | null>>
  >({});
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // 系统设置
  const [autolaunchEnabled, setAutolaunchEnabled] = useState(false);
  const [autolaunchLoading, setAutolaunchLoading] = useState(false);
  const [logDir, setLogDir] = useState("");

  // 本地化加速（即点即存）：映射 nuwaxLoadMode → 保存后重启生效
  const [loopbackEnabled, setLoopbackEnabled] = useState(false);
  const [loopbackApplying, setLoopbackApplying] = useState(false);

  // 语言
  const { lang: i18nLang } = useI18nLang();
  const [langList, setLangList] = useState<I18nLangDto[]>([]);
  const [langConfirmModalVisible, setLangConfirmModalVisible] = useState(false);
  const [langConfirmLoading, setLangConfirmLoading] = useState(false);
  const [pendingLang, setPendingLang] = useState("");

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

  // ========== 加载语言列表 ==========
  useEffect(() => {
    const loadLangList = async () => {
      try {
        const list = await fetchI18nLangList();
        if (list && list.length > 0) {
          setLangList(list);
        }
      } catch {
        // 失败时保持空，使用本地兜底
      }
    };
    loadLangList();
  }, []);

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

  // ========== 端口：行内提交，保存后提示需重启生效 ==========
  const commitPort = async (key: PortKey) => {
    if (!(key in portDrafts)) return;
    const draft = portDrafts[key];
    setPortDrafts((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    const saved = config?.[key];
    if (draft == null || draft === saved) return;
    setSaving(true);
    try {
      const latest = await setupService.getStep1Config();
      await setupService.saveStep1Config({ ...latest, [key]: draft });
      setConfig({ ...latest, [key]: draft });
      message.success(t(I18N_KEYS.Toast.SUCCESS.CONFIG_SAVED));
      message.info(t("Claw.Settings.saveConfig.restartHint"));
    } catch (error) {
      console.error("Failed to save port:", error);
      message.error(t(I18N_KEYS.Toast.ERROR.CONFIG_SAVE_FAILED));
    } finally {
      setSaving(false);
    }
  };

  // ========== 工作区目录：修改 / 打开 ==========
  const handleModifyWorkspace = async () => {
    const result = await window.electronAPI?.dialog.openDirectory(
      t("Claw.Settings.dialog.selectWorkspace"),
    );
    if (!result?.success || !result.path) return;
    setSaving(true);
    try {
      const latest = await setupService.getStep1Config();
      await setupService.saveStep1Config({
        ...latest,
        workspaceDir: result.path,
      });
      setConfig({ ...latest, workspaceDir: result.path });
      message.success(t(I18N_KEYS.Toast.SUCCESS.CONFIG_SAVED));
      message.info(t("Claw.Settings.saveConfig.restartHint"));
    } catch (error) {
      console.error("Failed to save workspace dir:", error);
      message.error(t(I18N_KEYS.Toast.ERROR.CONFIG_SAVE_FAILED));
    } finally {
      setSaving(false);
    }
  };

  const handleOpenWorkspaceDir = async () => {
    // 没有有效目录时直接提示，避免触发无意义 IPC 调用。
    if (!workspaceDir) {
      message.warning(t("Claw.Settings.messages.workspaceNotConfigured"));
      return;
    }
    try {
      const result = await window.electronAPI?.shell?.openPath(workspaceDir);
      if (!result?.success) {
        message.error(
          result?.error || t("Claw.Settings.messages.openWorkspaceFailed"),
        );
      }
    } catch {
      message.error(t("Claw.Settings.messages.openWorkspaceFailed"));
    }
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
      await window.electronAPI?.services?.restartAll?.();
      setLoopbackEnabled(checked);
      message.success(t(I18N_KEYS.Toast.SUCCESS.CONFIG_SAVED));
    } catch {
      // 失败必须可见且状态不落定——静默会让用户误以为已生效
      message.error(t(I18N_KEYS.Toast.ERROR.CONFIG_SAVE_FAILED));
    } finally {
      setLoopbackApplying(false);
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

  // ========== 语言切换 ==========
  const handleLanguageChange = async (lang: string) => {
    setPendingLang(lang);
    setLangConfirmModalVisible(true);
  };

  const handleLangConfirm = async () => {
    const lang = pendingLang;
    if (!lang) return;
    setLangConfirmLoading(true);

    // 确保 loading 最少展示 500ms，避免闪烁
    const minLoadingDelay = new Promise((resolve) => setTimeout(resolve, 500));

    try {
      // 1. 立即切换本地语言
      await setCurrentLang(lang);

      // 2. 预拉取目标语言翻译并缓存到 DB（与 loading 并行，不阻塞超过 500ms）
      //    失败时 reload 后后台仍会重试
      await Promise.allSettled([prefetchLangMap(lang), minLoadingDelay]);

      // 3. 标记下次初始化时强制 no-store 刷新翻译
      await scheduleLangMapRefreshOnNextInit(lang);

      // 4. 同步到主进程（检查返回值，失败则抛出）
      const result = await window.electronAPI?.i18n?.setLang(lang);
      if (result && !result.success) {
        throw new Error(result.error || "Main process language change failed");
      }

      // 5. 刷新页面
      window.location.reload();
    } catch (error) {
      console.error("Language change failed:", error);
      message.error(t("Claw.Settings.messages.languageChangeFailed"));
      setLangConfirmModalVisible(false);
    } finally {
      setLangConfirmLoading(false);
    }
  };

  const handleLangCancel = () => {
    setLangConfirmModalVisible(false);
    setPendingLang("");
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

      {/* 高级（端口，默认折叠） */}
      <div className={styles.group}>
        <button
          type="button"
          className={styles.advancedToggle}
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          <RightOutlined
            className={
              advancedOpen
                ? `${styles.chevron} ${styles.chevronOpen}`
                : styles.chevron
            }
          />
          <span>{t("Claw.Settings.group.advanced")}</span>
        </button>
        {advancedOpen && (
          <div className={styles.groupCard}>
            {(Object.keys(PORT_LABELS) as PortKey[]).map((key) => (
              <SettingsRow
                key={key}
                label={t(PORT_LABELS[key])}
                control={
                  <InputNumber
                    min={1}
                    max={65535}
                    style={{ width: 120 }}
                    value={
                      key in portDrafts ? portDrafts[key] : config?.[key]
                    }
                    disabled={saving}
                    onChange={(value) =>
                      setPortDrafts((prev) => ({
                        ...prev,
                        [key]: value,
                      }))
                    }
                    onBlur={() => commitPort(key)}
                    onPressEnter={() => commitPort(key)}
                  />
                }
              />
            ))}
          </div>
        )}
      </div>

      {/* 系统 */}
      <div className={styles.group}>
        <div className={styles.groupTitle}>
          {t("Claw.Settings.system.title")}
        </div>
        <div className={styles.groupCard}>
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
            desc={t("Claw.Settings.service.loopbackDesc")}
            control={
              <Switch
                checked={loopbackEnabled}
                onChange={handleLoopbackChange}
                loading={loopbackApplying}
              />
            }
          />

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

          {/* 语言设置 */}
          <SettingsRow
            label={t("Claw.Settings.system.language")}
            desc={t("Claw.Settings.system.languageDesc")}
            control={
              <Select
                style={{ width: 160 }}
                value={i18nLang}
                onChange={handleLanguageChange}
                options={
                  langList.length > 0
                    ? langList.map((item) => ({
                        value: item.lang.toLowerCase(),
                        label: item.name,
                      }))
                    : LOCAL_LANG_OPTIONS
                }
              />
            }
          />
        </div>
      </div>

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

      {/* 开发工具 - 仅开发模式 */}
      {IS_DEV && DevToolsPanel && (
        <div className={styles.group}>
          <div className={styles.groupCard}>
            <Suspense fallback={<Spin size="small" />}>
              <DevToolsPanel />
            </Suspense>
          </div>
        </div>
      )}

      {/* 语言切换确认弹窗 */}
      <Modal
        open={langConfirmModalVisible}
        title={t("Claw.Settings.languageConfirm.title")}
        onCancel={handleLangCancel}
        footer={[
          <Button key="cancel" onClick={handleLangCancel}>
            {t("Claw.Settings.languageConfirm.cancel")}
          </Button>,
          <Button
            key="confirm"
            type="primary"
            loading={langConfirmLoading}
            onClick={handleLangConfirm}
          >
            {t("Claw.Settings.languageConfirm.ok")}
          </Button>,
        ]}
      >
        <p>{t("Claw.Settings.languageConfirm.content")}</p>
      </Modal>
    </div>
  );
}
