import React from "react";
import styles from "../../styles/components/SettingsPage.module.css";

export function SettingsRow({ label, desc, descMono, control }: {
  label: React.ReactNode;
  desc?: React.ReactNode;
  descMono?: boolean;
  control?: React.ReactNode;
}) {
  return (
    <div className={styles.row}>
      <div className={styles.rowInfo}>
        <div className={styles.rowLabel}>{label}</div>
        {desc != null && <div className={descMono ? `${styles.rowDesc} ${styles.rowDescMono}` : styles.rowDesc}>{desc}</div>}
      </div>
      {control != null && <div className={styles.rowControl}>{control}</div>}
    </div>
  );
}
