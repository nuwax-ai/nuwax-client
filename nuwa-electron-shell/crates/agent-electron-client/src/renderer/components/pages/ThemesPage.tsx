import React from "react";
import { Select } from "antd";
import { FEATURES } from "@shared/featureFlags";
import { useTheme, type ThemeMode } from "../../App";
import { useDesktopThemes, ThemeManager, ThemePreviewSettings } from "../../features/themes";
import { t } from "../../services/core/i18n";
import { SettingsRow } from "../settings/SettingsRow";
import styles from "../../styles/components/SettingsPage.module.css";

export default function ThemesPage() {
  const desktopThemes = useDesktopThemes();
  const { themeMode, setThemeMode } = useTheme();

  return <div className={styles.page}>
    <ThemePreviewSettings t={t} Row={SettingsRow} className={`${styles.group} ${styles.groupCard}`} />
    {desktopThemes ? <ThemeManager state={desktopThemes} t={t} Row={SettingsRow} className={`${styles.groupCard} ${styles.cardContent}`} />
      : FEATURES.DARK_THEME && <div className={styles.groupCard}><SettingsRow
        label={t("Claw.Settings.system.theme")}
        desc={t("Claw.Settings.system.themeDesc")}
        control={<Select
          style={{ width: 140 }}
          value={themeMode}
          onChange={value => setThemeMode(value as ThemeMode)}
          options={[
            { value: "system", label: t("Claw.Settings.system.themeSystem") },
            { value: "light", label: t("Claw.Settings.system.themeLight") },
            { value: "dark", label: t("Claw.Settings.system.themeDark") },
          ]}
        />}
      /></div>}
  </div>;
}
