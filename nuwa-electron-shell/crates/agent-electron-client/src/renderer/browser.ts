import { createThemeApplicator } from "./features/themes";
import { startBrowserToolbar } from "./features/browser";
void startBrowserToolbar(createThemeApplicator).catch((error) =>
  console.error("[browser] Toolbar initialization failed", error)
);
