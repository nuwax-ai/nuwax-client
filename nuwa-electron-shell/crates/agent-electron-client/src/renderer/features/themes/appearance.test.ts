import { it, expect } from "vitest";
import { theme } from "antd";
import { packageTheme } from "./appearance";
import { defaultTokens, tokenToAntd } from "@shared/features/themes/core";
const rootTheme = {
  token: { fontSize: 13 },
  components: { Button: { fontWeight: 500, borderRadius: 8 } },
};
import type { HostThemeSnapshot } from "@shared/types/hostBridge";
it.each(["light", "dark"] as const)(
  "maps %s packages using shared sizes without legacy color overrides",
  (mode) => {
    const snapshot = {
      mode,
      tokens: { ...defaultTokens[mode], "surface.bg": "#112233" },
    } as unknown as HostThemeSnapshot;
    const result = packageTheme(snapshot, rootTheme);
    expect(result.algorithm).toBe(
      mode === "dark" ? theme.darkAlgorithm : theme.defaultAlgorithm
    );
    expect(result.components?.Button).toEqual({ fontWeight: 500 });
    expect(result.token).toMatchObject(tokenToAntd(snapshot.tokens));
    expect(result.token?.borderRadius).toBeDefined();
  }
);
