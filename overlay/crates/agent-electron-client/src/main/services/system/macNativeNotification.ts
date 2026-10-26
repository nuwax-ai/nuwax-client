import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import type { NotificationConstructorOptions } from "electron";

type NotificationEvent = "click" | "close" | "failed";
type NativeNotifications = {
  showNotification(id: string, title: string, body: string, silent: boolean, callback: (event: NotificationEvent, code: number) => void): void;
  releaseNotification(id: string): void;
  closeNotification(id: string): void;
};
const loadNative = createRequire(__filename);
let native: NativeNotifications | undefined;

/** Keep permission queries and delivery on UNUserNotificationCenter: macOS rejects mixing it with Electron 40's legacy API. */
export class MacNativeNotification extends EventEmitter {
  private readonly id = `nuwax.im.${randomUUID()}`;
  private backend: NativeNotifications | undefined;
  private listening = false;
  private closed = false;

  constructor(private readonly options: NotificationConstructorOptions) { super(); }

  show(): void {
    if (this.closed || this.listening) return;
    native ??= loadNative(path.join(__dirname, "mac-notification-permission.node")) as NativeNotifications;
    this.backend = native;
    this.listening = true;
    try {
      native.showNotification(this.id, this.options.title ?? "", this.options.body ?? "", this.options.silent === true, (event, code) => {
        if (!this.listening || this.closed) return;
        this.emit(event, event === "failed" ? { code } : undefined);
      });
    } catch (error) {
      this.listening = false;
      throw error;
    }
  }

  override removeAllListeners(event?: string | symbol): this {
    if (event === undefined) {
      this.listening = false;
      try { this.backend?.releaseNotification(this.id); }
      finally { super.removeAllListeners(); }
      return this;
    }
    return super.removeAllListeners(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listening = false;
    this.backend?.closeNotification(this.id);
  }
}
