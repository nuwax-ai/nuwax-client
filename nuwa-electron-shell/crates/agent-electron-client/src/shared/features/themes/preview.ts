export const THEME_PREVIEW_SETTING = "nuwax.themePreview.enabled";
export const THEME_PREVIEW_STATE = "nuwax.themePreview.state";

export interface ThemePreviewState {
  available: boolean;
  enabled: boolean;
  sourceForced: boolean;
  assetsReady: boolean;
  error?: string;
}
