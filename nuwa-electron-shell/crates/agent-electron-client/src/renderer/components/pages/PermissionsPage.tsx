import React, { useEffect, useState } from "react";
import { Alert, Button, Spin, Tag, message } from "antd";
import {
  SafetyCertificateOutlined,
  ArrowLeftOutlined,
  ArrowRightOutlined,
} from "@ant-design/icons";
import type {
  GuidedPermissionStatus,
  PermissionGuideTarget,
  PermissionKey,
  PermissionSnapshot,
} from "@shared/types/permissionOnboarding";
import {
  isDragAddPermissionKey,
  supportsPermissionGuide,
} from "@shared/types/permissionOnboarding";
import { watchPermissionSnapshot } from "../../services/permissionPolling";
import { t } from "../../services/core/i18n";
import styles from "../../styles/components/PermissionsPage.module.css";
import { IS_DEV_PROFILE } from "@shared/constants";
import { permissionHelperName } from "@shared/utils/permissionIdentityText";

const text = (key: string, ...values: string[]) =>
  t(`Claw.PermissionGuide.${key}`, ...values);
const color: Record<GuidedPermissionStatus, string> = {
  granted: "green",
  denied: "orange",
  unknown: "default",
  restart_required: "gold",
};
const badge: Record<string, { color: string; key: string }> = {
  required: { color: "volcano", key: "badgeRequired" },
  recommended: { color: "blue", key: "badgeRecommended" },
  optional: { color: "default", key: "badgeOptional" },
};
const labelKey = (key: string) =>
  key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
const pane = (key: PermissionKey) => labelKey(key.replace("helper_", ""));
const helperKey = (key: PermissionKey) => key.startsWith("helper_");
const required = (key: PermissionKey) =>
  key === "screen_recording" || helperKey(key)
    ? "required"
    : key === "file_access"
    ? "recommended"
    : "optional";

export default function PermissionsPage({
  target = "overview",
  onClose,
}: {
  target?: PermissionGuideTarget;
  onClose?(): void;
}) {
  const [snapshot, setSnapshot] = useState<PermissionSnapshot | null>(null);
  const [selected, setSelected] = useState<PermissionGuideTarget>(target);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const api = window.electronAPI?.permissionOnboarding;
  const available = supportsPermissionGuide(navigator.platform);
  useEffect(() => {
    setSelected(target);
  }, [target]);
  useEffect(() => {
    if (!available) return;
    if (!api) {
      setFailed(true);
      return;
    }
    return watchPermissionSnapshot({
      read: () => api.snapshot(),
      update: (value) => {
        setSnapshot(value);
        setFailed(false);
      },
      error: () => setFailed(true),
      document,
      window,
    });
  }, [api, available]);
  const action = async (run: () => Promise<boolean>) => {
    setBusy(true);
    try {
      if (!(await run())) message.error(text("actionFailed"));
    } catch {
      message.error(text("actionFailed"));
    } finally {
      setBusy(false);
    }
  };
  if (!available || (snapshot && !supportsPermissionGuide(snapshot.platform)))
    return null;
  if (!snapshot)
    return (
      <div className={styles.page}>
        {failed ? (
          <Alert type="warning" message={text("unavailable")} />
        ) : (
          <Spin />
        )}
      </div>
    );
  // Installation does not mean the user enabled Computer Use. Its permissions
  // become actionable only after that explicit enable intent.
  const items = snapshot.items.filter(item => !helperKey(item.key) || snapshot.helperEnabled === true);
  const granted = items.filter((item) => item.status === "granted").length;
  const index = items.findIndex((item) => item.key === selected);
  const subject = (key: PermissionKey) =>
    helperKey(key) ? permissionHelperName(IS_DEV_PROFILE) : snapshot.appName;
  const isMac = snapshot.platform === "darwin";
  const missingHelper =
    typeof selected === "string" &&
    selected.startsWith("helper_") &&
    !snapshot.helperAvailable;
  const canDrag = (key: PermissionKey) =>
    isMac &&
    isDragAddPermissionKey(key) &&
    (!helperKey(key) || snapshot.helperAppAvailable === true);
  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <div className={styles.eyebrow}>
            <SafetyCertificateOutlined /> NUWAX
          </div>
          <h2 className={styles.title}>{text("title")}</h2>
          <p className={styles.description}>{text("intro")}</p>
        </div>
        {onClose && (
          <Button onClick={onClose}>
            {text(granted === items.length ? "done" : "later")}
          </Button>
        )}
      </div>
      {failed && (
        <Alert type="warning" showIcon message={text("unavailable")} />
      )}
      {isMac ? (
        <>
          <div aria-live="polite" className={styles.description}>
            {text("progress", String(granted), String(items.length))}
          </div>
          <div className={styles.progress}>
            <span
              style={{
                width: `${items.length ? (granted / items.length) * 100 : 0}%`,
              }}
            />
          </div>
          <div className={styles.rows}>
            {items.map((item) => (
              <article
                key={item.key}
                className={`${styles.row} ${
                  selected === item.key ? styles.selected : ""
                }`}
              >
                <div className={styles.rowSummary}>
                <button
                  type="button"
                  id={`permission-row-${item.key}`}
                  className={styles.rowHead}
                  aria-expanded={selected === item.key}
                  onClick={() =>
                    setSelected(selected === item.key ? "overview" : item.key)
                  }
                >
                  <span className={styles.rowTitle}>
                    {text(`name.${pane(item.key)}`)}
                  </span>
                  <Tag color={badge[required(item.key)].color}>
                    {text(badge[required(item.key)].key)}
                  </Tag>
                  <span className={styles.spacer} />
                  <Tag aria-live="polite" color={color[item.status]}>
                    {text(`status.${labelKey(item.status)}`)}
                  </Tag>
                </button>
                <Button
                  className={styles.rowAction}
                  loading={busy}
                  onClick={() => void action(() => api!.openSettings(item.key))}
                >
                  {text("openSettings")}
                </Button>
                </div>
                <div className={styles.rowBody}>
                  <p className={styles.description}>
                    {text(`purpose.${labelKey(item.key)}`)}
                  </p>
                  {selected === item.key && <div className={styles.meta}>
                    {text("subject", subject(item.key))} ·{" "}
                    {text(required(item.key))}
                  </div>}
                </div>
                {selected === item.key && (
                  <section
                    className={styles.detail}
                    aria-label={text(`name.${pane(item.key)}`)}
                  >
                    <div className={styles.cardHeader}>
                      <h3>{text(`name.${pane(item.key)}`)}</h3>
                      <Tag aria-live="polite" color={color[item.status]}>
                        {text(`status.${labelKey(item.status)}`)}
                      </Tag>
                    </div>
                    <p className={styles.description}>
                      {text("subject", subject(item.key))}
                    </p>
                    <ol className={styles.steps}>
                      <li>{text(`step.${pane(item.key)}.step1`)}</li>
                      <li>
                        {text(
                          `step.${pane(item.key)}.step2`,
                          subject(item.key),
                        )}
                      </li>
                      <li>{text(`step.${pane(item.key)}.step3`)}</li>
                    </ol>
                    {helperKey(item.key) ? (
                      <Alert type="info" message={text("separateIdentity")} />
                    ) : (
                      <>
                        <code className={styles.path}>{snapshot.appPath}</code>
                        <Button
                          size="small"
                          onClick={() => void action(() => api!.showApp())}
                        >
                          {text("showApp")}
                        </Button>
                      </>
                    )}
                    {item.status === "unknown" && (
                      <p className={styles.description}>{text("unknownHelp")}</p>
                    )}
                    {(item.key === "screen_recording" ||
                      item.key === "helper_screen_recording") && (
                      <p className={`${styles.description} ${styles.notice}`}>
                        {text("screenConfirmation")}
                      </p>
                    )}
                    {(item.key === "screen_recording" ||
                      item.key === "file_access") &&
                      item.status !== "granted" && (
                        <div className={styles.notice}>
                          <p className={styles.description}>
                            {text(
                              item.status === "restart_required"
                                ? "restartHelp"
                                : "restartIfNeeded",
                            )}
                          </p>
                          <div className={styles.actions}>
                            <Button
                              loading={busy}
                              onClick={() => void action(() => api!.restart())}
                            >
                              {text("restart")}
                            </Button>
                          </div>
                        </div>
                      )}
                    <div className={styles.actions}>
                      <Button
                        type="primary"
                        loading={busy}
                        onClick={() =>
                          void action(() => api!.openSettings(item.key))
                        }
                      >
                        {text("openSettings")}
                      </Button>
                      {canDrag(item.key) && (
                        <Button
                          loading={busy}
                          onClick={() =>
                            void action(async () => {
                              const chip = await api!.showDragChip(item.key);
                              const opened = await api!.openSettings(item.key);
                              return chip || opened;
                            })
                          }
                        >
                          {text("dragAdd")}
                        </Button>
                      )}
                      <span className={styles.description}>
                        {text("autoRefresh")}
                      </span>
                    </div>
                    <div className={styles.footer}>
                      <Button
                        icon={<ArrowLeftOutlined />}
                        onClick={() =>
                          setSelected(index > 0 ? items[index - 1].key : "overview")
                        }
                      >
                        {text(index > 0 ? "previous" : "overview")}
                      </Button>
                      {index < items.length - 1 ? (
                        <Button
                          onClick={() => setSelected(items[index + 1].key)}
                        >
                          {text("next")} <ArrowRightOutlined />
                        </Button>
                      ) : (
                        onClose && <Button onClick={onClose}>{text("done")}</Button>
                      )}
                    </div>
                  </section>
                )}
              </article>
            ))}
          </div>
          {selected === "overview" && items.length > 0 && (
            <div className={styles.actions}>
              <Button
                type="primary"
                onClick={() =>
                  setSelected(
                    items.find((item) => item.status !== "granted")?.key ??
                      items[0].key,
                  )
                }
              >
                {text("start")}
              </Button>
            </div>
          )}
          {(!snapshot.helperEnabled || missingHelper) && (
            <div className={styles.notice}>
              <strong>Computer Use</strong>
              <p className={styles.description}>{text(snapshot.helperAppAvailable ? "helperDisabled" : "helperPending")}</p>
            </div>
          )}
          <details className={styles.help}>
            <summary>{text("troubleshooting")}</summary>
            <ol>
              <li>{text("troubleIdentity", snapshot.appName)}</li>
              <li>{text("troubleRestart")}</li>
              <li>{text("troubleReadd")}</li>
            </ol>
          </details>
        </>
      ) : (
        <section className={styles.detail}>
          <h3>{text("noPermissions")}</h3>
          <p className={styles.description}>
            {text(snapshot.platform === "win32" ? "windows" : "linux")}
          </p>
          <p className={`${styles.description} ${styles.notice}`}>
            {text(
              snapshot.platform === "win32" ? "windowsTrouble" : "linuxTest",
            )}
          </p>
          {snapshot.platform === "linux" && (
            <Button
              loading={busy}
              onClick={() => {
                void action(async () => {
                  const capture = window.electronAPI?.capture;
                  if (!capture) return false;
                  const result = await capture.screenshot();
                  if (!result.success) return result.code === "canceled";
                  await capture.release(result.resultId);
                  message.success(text("testPassed"));
                  return true;
                });
              }}
            >
              {text("testCapture")}
            </Button>
          )}
        </section>
      )}
    </div>
  );
}
