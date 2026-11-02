import { dialog, shell } from "electron";
import { readSetting } from "../../db";
import {
  BROWSER_SETTING,
  linkOpenMode,
} from "@shared/features/browser/contract";
import { isDesktopBrowserAvailable } from "../../features";
import { externalWebUrl } from "../../ipc/openExternal";
import { t } from "../i18n";
import { publicWebUrl } from '@shared/utils/publicWebUrl';

export const prefersDesktopBrowser = (): boolean =>
  linkOpenMode(readSetting(BROWSER_SETTING)) === "in-app" &&
  isDesktopBrowserAvailable();
export async function openSystemWebLink(
  value: string
): Promise<{ success: boolean; error?: string }> {
  const input = externalWebUrl(value);
  const step1 = readSetting('step1_config') as { serverHost?: string } | null;
  const loopback = readSetting('nuwax.loopback') as { origin?: string } | null;
  const url = input && publicWebUrl(input, { businessOrigin: step1?.serverHost, gatewayOrigin: loopback?.origin });
  if (!url) return { success: false, error: "Invalid webpage URL" };
  try {
    await shell.openExternal(url);
    return { success: true };
  } catch {
    return { success: false, error: "Unable to open external webpage" };
  }
}
export function openSystemPopupLink(url: string): void {
  void openSystemWebLink(url)
    .then((result) => {
      if (!result.success)
        dialog.showErrorBox(
          t("Claw.Browser.external"),
          t("Claw.Browser.externalFailed")
        );
    })
    .catch(() => {});
}
