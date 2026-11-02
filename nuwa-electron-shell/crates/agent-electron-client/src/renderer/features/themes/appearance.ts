import { theme, type ThemeConfig } from "antd";
import { tokenToAntd } from "@shared/features/themes/core";
import type { ThemeTokens } from "@shared/features/themes/core/types";
import type { HostThemeSnapshot } from "@shared/types/hostBridge";
export function packageTheme(
  snapshot: HostThemeSnapshot,
  rootTheme: ThemeConfig = {}
): ThemeConfig {
  const components = Object.fromEntries(
    Object.entries(rootTheme.components ?? {}).map(([key, values]) => [
      key,
      Object.fromEntries(
        Object.entries(values ?? {}).filter(
          ([name]) => !/^borderRadius/.test(name)
        )
      ),
    ])
  );
  return {
    ...rootTheme,
    components,
    algorithm:
      snapshot.mode === "dark" ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      ...rootTheme.token,
      ...tokenToAntd(snapshot.tokens as ThemeTokens),
    },
  };
}
