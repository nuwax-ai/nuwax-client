import type { WebContents } from "electron";

/** The privileged host stays on its own renderer; business pages use guests. */
export function isHostNavigationAllowed(target: string, entry: string): boolean {
  try {
    const url = new URL(target);
    const renderer = new URL(entry);
    if (url.username || url.password) return false;
    if (renderer.protocol === "file:") {
      url.search = renderer.search = "";
      url.hash = renderer.hash = "";
      return url.href === renderer.href;
    }
    // Development uses one Vite origin. Never broaden this to all loopback ports.
    return ["http:", "https:"].includes(renderer.protocol) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(renderer.hostname) &&
      url.origin === renderer.origin;
  } catch {
    return false;
  }
}

export function guardHostNavigation(contents: WebContents, rendererEntry: string): void {
  // Cover renderer navigation and redirects, including a frame targeting _top.
  // loadURL/loadFile remain owned by the main process for startup and recovery.
  const guard = (event: { url: string; isMainFrame: boolean; preventDefault(): void }) => {
    if (event.isMainFrame && !isHostNavigationAllowed(event.url, rendererEntry)) {
      event.preventDefault();
    }
  };
  contents.on("will-frame-navigate", guard);
  contents.on("will-redirect", guard);
}
