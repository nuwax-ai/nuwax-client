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
import { supportsPermissionGuide } from "@shared/types/permissionOnboarding";
import { watchPermissionSnapshot } from "../../services/permissionPolling";
import { t } from "../../services/core/i18n";
import styles from "../../styles/components/PermissionsPage.module.css";

const text = (key: string, ...values: string[]) =>
  t(`Claw.PermissionGuide.${key}`, ...values);
const color: Record<GuidedPermissionStatus, string> = {
  granted: "green",
  denied: "orange",
  unknown: "default",
  restart_required: "gold",
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
  const items = snapshot.items;
  const granted = items.filter((item) => item.status === "granted").length;
  const current = items.find((item) => item.key === selected);
  const index = items.findIndex((item) => item.key === selected);
  const subject = (key: PermissionKey) =>
    helperKey(key) ? "Nuwax Computer Use" : snapshot.appName;
  const isMac = snapshot.platform === "darwin";
  const missingHelper =
    typeof selected === "string" &&
    selected.startsWith("helper_") &&
    !snapshot.helperAvailable;
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
          <div className={styles.grid}>
            {items.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`${styles.card} ${
                  selected === item.key ? styles.selected : ""
                }`}
                aria-pressed={selected === item.key}
                onClick={() => setSelected(item.key)}
              >
                <div className={styles.cardHeader}>
                  <span className={styles.cardTitle}>
                    {text(`name.${pane(item.key)}`)}
                  </span>
                  <Tag color={color[item.status]}>
                    {text(`status.${labelKey(item.status)}`)}
                  </Tag>
                </div>
                <p className={styles.description}>
                  {text(`purpose.${labelKey(item.key)}`)}
                </p>
                <div className={styles.meta}>
                  {text("subject", subject(item.key))} ·{" "}
                  {text(required(item.key))}
                </div>
              </button>
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
          {current && (
            <section
              className={styles.detail}
              aria-label={text(`name.${pane(current.key)}`)}
            >
              <div className={styles.cardHeader}>
                <h3>{text(`name.${pane(current.key)}`)}</h3>
                <Tag aria-live="polite" color={color[current.status]}>
                  {text(`status.${labelKey(current.status)}`)}
                </Tag>
              </div>
              <p className={styles.description}>
                {text("subject", subject(current.key))}
              </p>
              <ol className={styles.steps}>
                <li>{text(`step.${pane(current.key)}.step1`)}</li>
                <li>
                  {text(
                    `step.${pane(current.key)}.step2`,
                    subject(current.key),
                  )}
                </li>
                <li>{text(`step.${pane(current.key)}.step3`)}</li>
              </ol>
              {helperKey(current.key) ? (
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
              {current.status === "unknown" && (
                <p className={styles.description}>{text("unknownHelp")}</p>
              )}
              {(current.key === "screen_recording" ||
                current.key === "helper_screen_recording") && (
                <p className={`${styles.description} ${styles.notice}`}>
                  {text("screenConfirmation")}
                </p>
              )}
              {(current.key === "screen_recording" ||
                current.key === "file_access") &&
                current.status !== "granted" && (
                  <div className={styles.notice}>
                    <p className={styles.description}>
                      {text(
                        current.status === "restart_required"
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
                    void action(() => api!.openSettings(current.key))
                  }
                >
                  {text("openSettings")}
                </Button>
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
                  <Button onClick={() => setSelected(items[index + 1].key)}>
                    {text("next")} <ArrowRightOutlined />
                  </Button>
                ) : (
                  onClose && <Button onClick={onClose}>{text("done")}</Button>
                )}
              </div>
            </section>
          )}
          {(!snapshot.helperAvailable || missingHelper) && (
            <div className={styles.notice}>
              <strong>Computer Use</strong>
              <p className={styles.description}>{text("helperPending")}</p>
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
