import { I18N_KEYS } from "@shared/constants";
import React, { useEffect, useState } from "react";
import { useDistHandshake } from "../hooks/useDistHandshake";
import { shouldShowDistSnapshotNotice } from "../services/distHandshake";
import { t } from "../services/core/i18n";
import styles from "./DistSnapshotNotice.module.css";

export function DistSnapshotNotice({ guestUrl, onOpenSettings }: { guestUrl: string; onOpenSettings?: () => void }) {
  let loopback = false;
  try { loopback = ["127.0.0.1", "localhost", "[::1]"].includes(new URL(guestUrl).hostname); } catch { /* No resolved guest yet. */ }
  const { snapshot } = useDistHandshake(loopback);
  if (!snapshot?.cloud || !shouldShowDistSnapshotNotice(snapshot, guestUrl)) return null;
  const settingsKey = `nuwax.distSnapshotNotice.dismissed:${snapshot.backendOrigin}`;
  // 网关端口会随进程变化，关闭状态按后端与线上构建记忆。
  const version = JSON.stringify([snapshot.cloud.name, snapshot.cloud.version, snapshot.cloud.gitHash || ""]);
  return <VersionNotice key={JSON.stringify([settingsKey, version])} settingsKey={settingsKey} version={version} onOpenSettings={onOpenSettings} />;
}

function VersionNotice({ settingsKey, version, onOpenSettings }: {
  settingsKey: string;
  version: string;
  onOpenSettings?: () => void;
}) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let active = true;
    const showUnlessDismissed = (saved?: unknown) => {
      if (active) setVisible(saved !== version);
    };
    void Promise.resolve()
      .then(() => window.electronAPI?.settings.get(settingsKey))
      .then(showUnlessDismissed, () => showUnlessDismissed());
    return () => { active = false; };
  }, [settingsKey, version]);

  const dismiss = () => {
    setVisible(false);
    void Promise.resolve()
      .then(() => window.electronAPI?.settings.set(settingsKey, version))
      .catch(() => {});
  };
  if (!visible) return null;
  return <aside role="status" className={styles.notice}>
    <div className={styles.message}>
      <span>{t(I18N_KEYS.DistCheck.NOTICE)}</span>
      <button type="button" aria-label={t(I18N_KEYS.DistCheck.DISMISS)} onClick={dismiss} className={styles.close}>×</button>
    </div>
    {onOpenSettings && <button type="button" onClick={onOpenSettings} className={styles.settings}>{t(I18N_KEYS.DistCheck.OPEN_SETTINGS)}</button>}
  </aside>;
}
