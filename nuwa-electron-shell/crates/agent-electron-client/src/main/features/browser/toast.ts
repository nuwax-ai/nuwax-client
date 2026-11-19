import { WebContentsView, type BrowserWindow } from "electron";

const MAX_WIDTH = 340;
const HEIGHT = 48;
const DURATION_MS = 2200;

function toastUrl(message: string, success: boolean): string {
  const text = message.replace(/[&<>]/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character]!,
  );
  const icon = success
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>'
    : "";
  return "data:text/html;charset=utf-8," + encodeURIComponent(`<!doctype html>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
  body { box-sizing: border-box; margin: 0; padding: 0 8px; height: 100vh;
    display: flex; align-items: center; justify-content: center; overflow: hidden; user-select: none; }
  #toast { box-sizing: border-box; display: inline-flex; flex: none; align-items: center; gap: 8px;
    max-width: 100%; width: max-content; height: 36px; padding: 0 14px; border-radius: 8px;
    background: #333; color: #fff; font: 13px system-ui; box-shadow: 0 2px 6px #0003; }
  span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  svg { width: 16px; height: 16px; flex-shrink: 0; fill: none; stroke: #7cdb9b;
    stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
</style>
<div id="toast" role="status">${icon}<span>${text}</span></div>`);
}

export function createBrowserToast(owner: BrowserWindow, warn: () => void) {
  let closeCurrent: (() => void) | undefined;
  const dismiss = () => closeCurrent?.();

  async function show(message: string, success = true): Promise<void> {
    dismiss();
    if (owner.isDestroyed()) return;

    // The page is a native child view above the toolbar renderer. Give feedback
    // its own compact view in the same window so it can paint above the page.
    const view = new WebContentsView({
      webPreferences: { partition: "nuwax-browser-ui", sandbox: true, devTools: false },
    });
    const contents = view.webContents;
    let preferredWidth = MAX_WIDTH;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const layout = () => {
      const [width, height] = owner.getContentSize();
      const toastWidth = Math.min(preferredWidth, width);
      view.setBounds({
        x: Math.round((width - toastWidth) / 2),
        y: Math.max(0, Math.round((height - HEIGHT) / 2)),
        width: toastWidth,
        height: HEIGHT,
      });
    };
    const close = () => {
      if (closeCurrent !== close) return;
      closeCurrent = undefined;
      clearTimeout(timer);
      owner.removeListener("resize", layout);
      owner.removeListener("hide", close);
      owner.removeListener("minimize", close);
      owner.removeListener("closed", close);
      if (!owner.isDestroyed()) owner.contentView.removeChildView(view);
      if (!contents.isDestroyed()) contents.close();
    };
    closeCurrent = close;
    try {
      view.setBackgroundColor("#00000000");
      view.setVisible(false);
      owner.contentView.addChildView(view);
      owner.on("resize", layout);
      owner.once("hide", close);
      owner.once("minimize", close);
      owner.once("closed", close);
      layout();
      await contents.loadURL(toastUrl(message, success));
      if (closeCurrent !== close) return;
      const width = await contents.executeJavaScript(`
        document.fonts.ready.then(() => {
          const toast = document.getElementById('toast');
          toast.style.maxWidth = 'none';
          const width = Math.ceil(toast.getBoundingClientRect().width) + 16;
          toast.style.removeProperty('max-width');
          return width;
        })
      `);
      if (closeCurrent !== close) return;
      if (typeof width === "number" && width > 16) preferredWidth = width;
      layout();
      view.setVisible(true);
      timer = setTimeout(close, DURATION_MS);
    } catch (error) {
      if (closeCurrent === close) {
        close();
        throw error;
      }
    }
  }

  return {
    show(message: string, success = true) {
      void show(message, success).catch(warn);
    },
    dismiss,
  };
}
