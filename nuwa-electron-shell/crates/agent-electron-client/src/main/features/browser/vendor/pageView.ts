/* Adapted from electron-browser-shell packages/shell/browser/tabs.js, MIT.
 * Upstream: 3817c4236f8511156086eb4541f364679b277b40. See LICENSE and UPSTREAM.md.
 */
import {
  WebContentsView,
  type BrowserWindow,
  type WebContents,
  type WebPreferences,
} from "electron";
import { BROWSER_TOOLBAR_HEIGHT } from "@shared/features/browser/contract";

/** Upstream Tab's view ownership/layout, reduced to one page per window. */
export class PageView {
  readonly view: WebContentsView;
  readonly webContents: WebContents;
  toolbarHeight = BROWSER_TOOLBAR_HEIGHT;
  private destroyed = false;
  constructor(
    readonly window: BrowserWindow,
    options: { webContents?: WebContents; webPreferences?: WebPreferences },
  ) {
    const cleaned = { ...options };
    if (!cleaned.webContents) delete cleaned.webContents;
    if (!cleaned.webPreferences) delete cleaned.webPreferences;
    this.view = new WebContentsView(cleaned);
    this.webContents = this.view.webContents;
    window.contentView.addChildView(this.view);
    window.on("resize", this.invalidateLayout);
    this.invalidateLayout();
  }
  invalidateLayout = (): void => {
    if (this.destroyed || this.window.isDestroyed()) return;
    const [width, height] = this.window.getContentSize();
    this.view.setBounds({
      x: 0,
      y: this.toolbarHeight,
      width,
      height: Math.max(0, height - this.toolbarHeight),
    });
  };
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.window.removeListener("resize", this.invalidateLayout);
    if (!this.window.isDestroyed())
      this.window.contentView.removeChildView(this.view);
    if (!this.webContents.isDestroyed())
      this.webContents.close({ waitForBeforeUnload: false });
  }
}
