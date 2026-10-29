import { I18N_KEYS } from "@shared/constants";
import React, { useState } from "react";
import { useDistHandshake } from "../hooks/useDistHandshake";
import { shouldShowDistSnapshotNotice } from "../services/distHandshake";
import { t } from "../services/core/i18n";
import styles from "./DistSnapshotNotice.module.css";

export function DistSnapshotNotice({ guestUrl, onOpenSettings }: { guestUrl: string; onOpenSettings?: () => void }) {
  let loopback = false;
  try { loopback = ["127.0.0.1", "localhost", "[::1]"].includes(new URL(guestUrl).hostname); } catch { /* No resolved guest yet. */ }
  const { snapshot } = useDistHandshake(loopback);
  const [dismissed, setDismissed] = useState("");
  const identity = snapshot ? JSON.stringify([snapshot.backendOrigin, snapshot.bundled, snapshot.cloud, snapshot.gateway]) : "";
  if (!shouldShowDistSnapshotNotice(snapshot, guestUrl) || dismissed === identity) return null;
  return <aside role="status" className={styles.notice}>
    <div className={styles.message}>
      <span>{t(I18N_KEYS.DistCheck.NOTICE)}</span>
      <button type="button" aria-label={t(I18N_KEYS.DistCheck.DISMISS)} onClick={() => setDismissed(identity)} className={styles.close}>×</button>
    </div>
    {onOpenSettings && <button type="button" onClick={onOpenSettings} className={styles.settings}>{t(I18N_KEYS.DistCheck.OPEN_SETTINGS)}</button>}
  </aside>;
}
