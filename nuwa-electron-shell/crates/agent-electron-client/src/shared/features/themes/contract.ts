export type {
  HostThemesBridge,
  HostThemesState,
  HostThemeResult,
  HostThemeFiles,
  HostThemePreference,
} from '../../types/hostBridge';
export const THEMES_CHANGED = 'themes:changed';
export const themeChannel = (method: string, host = false): string =>
  `${host ? 'host:' : ''}themes:${method}`;
export { THEME_PREVIEW_SETTING, THEME_PREVIEW_STATE, type ThemePreviewState } from "./preview";
