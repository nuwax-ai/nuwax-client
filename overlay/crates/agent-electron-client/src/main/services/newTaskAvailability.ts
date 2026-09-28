import type { WebContents } from "electron";
import { APP_NAME_IDENTIFIER } from "@shared/constants";

// 商业版等待业务页面确认菜单可用；社区版沿用已有的快捷键行为。
const defaultAvailable = APP_NAME_IDENTIFIER !== "nuwax";
const guestAvailability = new WeakMap<WebContents, boolean>();
const trackedGuests = new WeakSet<WebContents>();
const retiredMainGuests = new WeakSet<WebContents>();
const mainSubscribers = new Set<() => void>();
let mainGuest: WebContents | null = null;
let mainHost: WebContents | null = null;
let mainAvailable = defaultAvailable;

function notifyMainAvailability(host: WebContents | null): void {
  if (host && !host.isDestroyed()) {
    host.send("nuwax:layout-changed", { newTaskAvailable: mainAvailable });
  }
  for (const subscriber of mainSubscribers) subscriber();
}

function resetGuestAvailability(guest: WebContents, destroyed = false): void {
  guestAvailability.delete(guest);
  // 被替换的旧 guest 与独立窗口不能清理当前主窗口的能力状态。
  if (guest !== mainGuest) return;
  const changed = mainAvailable !== defaultAvailable;
  const host = mainHost;
  mainAvailable = defaultAvailable;
  if (destroyed) {
    mainGuest = null;
    mainHost = null;
  }
  if (changed) notifyMainAvailability(host);
}

function trackGuest(guest: WebContents): void {
  if (trackedGuests.has(guest)) return;
  trackedGuests.add(guest);
  guest.on("did-start-navigation", (details, _url, isInPlace, isMainFrame) => {
    // 同时兼容 Electron 新事件字段和旧参数；SPA 与子 frame 导航保留状态。
    const mainFrame = details.isMainFrame ?? isMainFrame;
    const sameDocument = details.isSameDocument ?? isInPlace;
    if (mainFrame && !sameDocument) resetGuestAvailability(guest);
  });
  guest.on("destroyed", () => resetGuestAvailability(guest, true));
}

/** 只接收已通过 IPC 受信来源校验的页面能力上报。 */
export function setGuestNewTaskAvailable(
  guest: WebContents,
  available: boolean,
  host?: WebContents,
): void {
  if (guest.isDestroyed()) return;
  trackGuest(guest);
  guestAvailability.set(guest, available);
  if (!host || guest.hostWebContents !== host || retiredMainGuests.has(guest)) return;

  const changed = mainGuest !== guest || mainAvailable !== available;
  // 切换后的旧页面可能迟到上报卸载状态，不能重新成为主 guest。
  if (mainGuest && mainGuest !== guest) retiredMainGuests.add(mainGuest);
  mainGuest = guest;
  mainHost = host;
  mainAvailable = available;
  if (changed) notifyMainAvailability(host);
}

export function isGuestNewTaskAvailable(guest: WebContents): boolean {
  if (guest.isDestroyed()) return defaultAvailable;
  return guestAvailability.get(guest) ?? defaultAvailable;
}

export function isMainNewTaskAvailable(): boolean {
  return mainAvailable;
}

export function onMainNewTaskAvailabilityChanged(
  subscriber: () => void,
): () => void {
  mainSubscribers.add(subscriber);
  return () => mainSubscribers.delete(subscriber);
}
