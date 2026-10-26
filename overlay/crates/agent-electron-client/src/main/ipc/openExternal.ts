import type { IpcMainInvokeEvent, WebContents } from "electron";

function isRendererDocument(value: string, entry: string): boolean {
  try {
    const url = new URL(value), renderer = new URL(entry);
    if (url.username || url.password) return false;
    if (renderer.protocol === "file:") {
      url.search = renderer.search = "";
      url.hash = renderer.hash = "";
      return url.href === renderer.href;
    }
    return ["http:", "https:"].includes(renderer.protocol) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(renderer.hostname) &&
      url.origin === renderer.origin;
  } catch { return false; }
}

/** Only the actual host main frame can ask the OS to open a webpage. */
export function isExternalOpenSender(event: IpcMainInvokeEvent, host: WebContents | undefined, entry: string): boolean {
  try {
    return !!host && !host.isDestroyed() && event.sender === host &&
      event.senderFrame === host.mainFrame && !!event.senderFrame &&
      isRendererDocument(host.getURL(), entry) && isRendererDocument(event.senderFrame.url, entry);
  } catch { return false; }
}

export function externalWebUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 8192 ||
      !/^https?:\/\//i.test(value) || /[\x00-\x20\x7f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !!url.hostname &&
      !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function createExternalOpenHandler(
  getHost: () => WebContents | undefined,
  rendererEntry: string,
  openExternal: (url: string) => Promise<void>,
) {
  return async (event: IpcMainInvokeEvent, value: unknown) => {
    if (!isExternalOpenSender(event, getHost(), rendererEntry)) {
      return { success: false, error: "Untrusted external-open source" };
    }
    const url = externalWebUrl(value);
    if (!url) return { success: false, error: "Only HTTP(S) webpages can be opened externally" };
    try {
      await openExternal(url);
      return { success: true };
    } catch {
      // OS errors can echo the supplied URL; never persist it in logs or errors.
      return { success: false, error: "Unable to open external webpage" };
    }
  };
}
