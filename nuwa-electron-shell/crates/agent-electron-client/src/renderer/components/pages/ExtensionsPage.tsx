import React, { useEffect, useState } from "react";
import { APP_NAME_IDENTIFIER, I18N_KEYS } from "@shared/constants";
import { DshSettings } from "../../features/dsh-runtime";
import { WorkbenchSettings } from "../../features/workbench";
import { ShellCapabilitiesSettings } from "../../features/shell-capabilities";
import { t } from "../../services/core/i18n";
import { SettingsRow } from "../settings/SettingsRow";
import styles from "../../styles/components/SettingsPage.module.css";

export default function ExtensionsPage() {
  const [registeredFeatures, setRegisteredFeatures] = useState<string[]>([]);
  useEffect(() => {
    let active = true;
    void window.electronAPI?.features?.registered?.()
      .then(ids => { if (active) setRegisteredFeatures(ids ?? []); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  return <div className={styles.page}>
    <p className={styles.intro}>{t(I18N_KEYS.SettingsNavigation.extensionsDescription)}</p>
    {APP_NAME_IDENTIFIER === "nuwax" && <div className={styles.group}>
      <div className={styles.groupCard}><WorkbenchSettings t={t} Row={SettingsRow} /><DshSettings t={t} Row={SettingsRow} /></div>
    </div>}
    {registeredFeatures.includes("shell-capabilities") && <div className={styles.group}>
      <div className={styles.groupCard}><ShellCapabilitiesSettings t={t} Row={SettingsRow} /></div>
    </div>}
  </div>;
}
