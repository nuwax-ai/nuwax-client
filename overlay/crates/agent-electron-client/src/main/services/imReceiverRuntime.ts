import { app, BrowserWindow, net, powerMonitor } from "electron";
import log from "electron-log";
import WebSocket from "ws";
import JSONBigInt from "json-bigint";
import { readSetting, writeSetting } from "../db";
import { currentBusinessOrigin } from "./commercialSessionScope";
import { businessBridgeOrigins, httpOrigin } from "./auth/businessOrigins";
import { currentTicket, ticketEpoch, mirrorNativeResponseTicket, mirrorGatewaySetCookies } from "./commercialTicketSession";
import { nativeTicketHeaders } from "./nativeTicketCapability";
import { getDeviceId } from "./system/deviceId";
import { IMReceiver, IMReceiverError, type IMReceiverSession } from "./imReceiver";
import { createIMNativePresentation } from "./imNativePresentation";
import type { IMUnreadSnapshot } from "@shared/types/imReceiver";
import { APP_NAME_IDENTIFIER } from "@shared/constants";

const json = JSONBigInt({storeAsString: true, strict: true});
const ENABLED_KEY = "nuwax.im.notifications.enabled";
type NotificationDecision = "invalid-message" | "own-message" | "duplicate" | "notifications-disabled" |
  "receiver-unavailable" | "business-foreground" | "queued" | "queue-limit" | "superseded" |
  "cancelled" | "session-changed" | "dnd" | "conversation-lookup-failed" | "native-requested" | "native-skipped";
let runtime: ReturnType<typeof createRuntime> | null = null;
let quitting = false;
const unreadListeners = new Set<(snapshot: IMUnreadSnapshot | null) => void>();

function publishUnread(snapshot: IMUnreadSnapshot | null): void {
  for (const listener of unreadListeners) listener(snapshot);
}

function createRuntime(getMainWindow: () => BrowserWindow | null) {
  let disposed = false;
  let notifyEnabled = readSetting(ENABLED_KEY) !== false;
  const controllers = new Set<AbortController>();
  const messages = new Map<string, {body: Record<string, any>; generation: number; current(): boolean; selfId: string; trace: number}>();
  const seen = new Set<string>();
  let presenting = 0;
  let notificationSequence = 0;
  // 辅助的 file:// 截图/CU 窗口有焦点，不代表用户正在查看业务消息。
  // 二级业务页按当前桥准入重新判断，换域或 loopback 关闭后不保留旧身份。
  const businessWindows = () => {
    const main = getMainWindow();
    const origins = businessBridgeOrigins();
    return [...new Set([...BrowserWindow.getAllWindows(), ...(main ? [main] : [])])].filter(win => {
      if (win.isDestroyed()) return false;
      if (win === main) return true;
      try {
        if (win.webContents.isDestroyed()) return false;
        const origin = httpOrigin(win.webContents.getURL());
        return origin !== null && origins.includes(origin);
      } catch { return false; }
    });
  };
  const foreground = () => businessWindows().some(win => win.isFocused());
  const presentationBlock = (): NotificationDecision | null => !notifyEnabled ? "notifications-disabled" :
    disposed || !receiver.canReceive() ? "receiver-unavailable" : foreground() ? "business-foreground" : null;
  const canPresent = () => presentationBlock() === null;
  // trace 仅是进程内递增序号；不记录消息/会话 ID、正文、地址或凭据。
  const decision = (trace: number, reason: NotificationDecision) => log.info("[IMReceiver] notification", {trace, reason});
  const native = createIMNativePresentation({
    getMainWindow,
    getBusinessWindows: businessWindows,
    isSessionCurrent: generation => receiver.isGenerationCurrent(generation),
    isNotificationAllowed: canPresent,
  });
  const sameSession = (session: IMReceiverSession) => !disposed && !quitting &&
    session.origin === currentBusinessOrigin() && session.epoch === ticketEpoch() && !!currentTicket();
  const request = async (session: IMReceiverSession, path: string, signal: AbortSignal, body?: object): Promise<any> => {
    if (!sameSession(session)) throw new Error("IM session changed");
    const ticket = currentTicket();
    if (!ticket) throw new IMReceiverError("IM_10401");
    const response = await net.fetch(`${session.origin}${path}`, {
      method: body ? "POST" : "GET", credentials: "omit", redirect: "error",
      headers: {...nativeTicketHeaders(ticket), "x-client-type": "nuwax", ...(body ? {"Content-Type": "application/json"} : {})},
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      ...(body ? {body: JSON.stringify(body)} : {}),
    });
    if (!sameSession(session) || signal.aborted) throw new Error("IM session changed");
    await mirrorNativeResponseTicket(response, session.origin, session.epoch);
    if (!sameSession(session) || signal.aborted) throw new Error("IM session changed");
    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
      // Gate auth failures even when an upstream proxy sends a non-JSON error page.
      let code = response.status === 401 ? "IM_10401" : "IM_10403";
      try {
        const rejected = json.parse(text);
        if (typeof rejected?.code === "string" && rejected.code.startsWith("IM_")) code = rejected.code;
      } catch { /* HTTP status is sufficient to stop this session. */ }
      throw new IMReceiverError(code);
    }
    const envelope = json.parse(text);
    if (!response.ok || envelope.code !== "0000") {
      if (typeof envelope.code === "string" && envelope.code.startsWith("IM_")) throw new IMReceiverError(envelope.code);
      throw new Error(`IM HTTP ${response.status}`);
    }
    return envelope.data;
  };
  const abortPresentations = () => {
    for (const item of messages.values()) decision(item.trace, "cancelled");
    messages.clear();
    for (const controller of controllers) controller.abort();
    controllers.clear();
  };
  const clearActions = () => {
    abortPresentations();
    seen.clear();
    native.clear();
  };
  const receiver = new IMReceiver({
    isOnline: () => net.isOnline(), isForeground: foreground, isSessionCurrent: sameSession,
    register: (session, signal) => request(session, "/api/instant-message/devices", signal, {
      deviceId: session.deviceId, platform: "desktop", pushEnabled: false, appVersion: app.getVersion(),
    }),
    connect: (session, callbacks) => {
      const ticket = currentTicket();
      if (!sameSession(session) || !ticket) throw new IMReceiverError("IM_10401");
      const url = new URL("/instant-message/ws", session.origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      // Node ws 不经过 Electron webRequest；不能发送 nativeTicketHeaders 中的私有能力标记。
      const socket = new WebSocket(url, "im-v1", {headers: {Cookie: `ticket=${ticket}`, "x-client-type": "nuwax"},
        followRedirects: false, handshakeTimeout: 10_000, maxPayload: 1024 * 1024, perMessageDeflate: false});
      let closed = false;
      const failed = () => { if (!closed) { closed = true; callbacks.close(); } };
      socket.on("open", callbacks.open);
      socket.on("message", (data, binary) => {
        if (closed || binary || !sameSession(session)) return;
        try {
          const packet = json.parse(data.toString());
          if (packet && typeof packet === "object" && !Array.isArray(packet)) callbacks.packet(packet);
        }
        catch { /* 畸形帧不进入业务态，不打印消息正文。 */ }
      });
      socket.on("close", failed);
      socket.on("error", failed);
      socket.on("upgrade", response => {
        const cookies = response.headers["set-cookie"];
        if (cookies?.length && sameSession(session)) void mirrorGatewaySetCookies(cookies, session.origin, session.epoch)
          .catch(() => { if (sameSession(session) && callbacks.isCurrent()) receiver.stop(); });
      });
      socket.on("unexpected-response", (_request, response) => {
        if (response.statusCode === 401 || response.statusCode === 403)
          callbacks.packet({v: 1, op: 1002, code: "IM_10401"});
        response.resume();
        failed();
      });
      return {
        send: packet => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(packet)); },
        close: () => { closed = true; socket.removeListener("open", callbacks.open); socket.terminate(); },
      };
    },
    unread: (session, signal) => request(session, "/api/instant-message/unread-total", signal),
    onUnread: snapshot => {
      native.setUnreadCount(snapshot.total);
      publishUnread(snapshot);
    },
    onClear: clearActions,
    onBlocked: reason => {
      abortPresentations();
      log.warn("[IMReceiver] connection blocked", {reason});
    },
    log: state => log.info("[IMReceiver] state", {state}),
    onMessage: (body, generation, current, selfId) => {
      const trace = ++notificationSequence;
      const convId = body.convId === undefined ? "" : String(body.convId);
      const msgId = body.msgId === undefined ? "" : String(body.msgId);
      const reason = !convId || !msgId || !selfId ? "invalid-message" : String(body.senderId) === selfId ? "own-message" :
        presentationBlock() ?? (seen.has(msgId) ? "duplicate" : null);
      if (reason) { decision(trace, reason); return; }
      seen.add(msgId);
      while (seen.size > 2048) seen.delete(seen.values().next().value!);
      // 突发消息按会话保留最新提醒；角标仍由服务端全量数决定。
      if (messages.size >= 50 && !messages.has(convId)) {
        const [oldestId, oldest] = messages.entries().next().value!;
        decision(oldest.trace, "queue-limit");
        messages.delete(oldestId);
      }
      const previous = messages.get(convId);
      if (previous) decision(previous.trace, "superseded");
      messages.set(convId, {body, generation, current, selfId, trace});
      decision(trace, "queued");
      pumpMessages();
    },
  });
  function pumpMessages() {
    if (presenting >= 2 || !messages.size || disposed) return;
    const [convId, item] = messages.entries().next().value!;
    messages.delete(convId);
    const blocked = !item.current() ? "session-changed" : presentationBlock();
    if (blocked) { decision(item.trace, blocked); pumpMessages(); return; }
    const snapshotSession = activeSession;
    if (!snapshotSession) { decision(item.trace, "session-changed"); return; }
    const controller = new AbortController();
    controllers.add(controller);
    presenting++;
    void request(snapshotSession, `/api/instant-message/conversations/${encodeURIComponent(convId)}`, controller.signal)
      .then(conv => {
        const blocked = controller.signal.aborted ? "cancelled" : !item.current() ? "session-changed" : presentationBlock();
        if (blocked) { decision(item.trace, blocked); return; }
        const mentioned = item.body.mentionAll === true ||
          (Array.isArray(item.body.mentionUserIds) && item.body.mentionUserIds.some((id: unknown) => String(id) === item.selfId));
        if (conv.dnd === true && !mentioned) { decision(item.trace, "dnd"); return; }
        const group = [2, 4].includes(Number(conv.convType));
        const title = String(group ? conv.name || item.body.senderName || "IM" : item.body.senderName || conv.peerName || conv.name || "IM");
        const body = String(item.body.digest || "").replace(/<[^>]*>/g, "").replace(/[\r\n]+/g, " ").slice(0, 200);
        const requested = native.showMessage({sessionGeneration: item.generation, msgId: String(item.body.msgId), convId, title, body, diagnosticTrace: item.trace});
        decision(item.trace, requested ? "native-requested" : "native-skipped");
      }).catch(() => {
        decision(item.trace, controller.signal.aborted ? "cancelled" : !item.current() ? "session-changed" : "conversation-lookup-failed");
      })
      .finally(() => { controllers.delete(controller); presenting--; pumpMessages(); });
    pumpMessages();
  }
  let activeSession: IMReceiverSession | null = null;
  const lock = () => { receiver.setLocked(true); abortPresentations(); };
  const unlock = () => receiver.setLocked(false);
  const suspend = () => { receiver.setSuspended(true); abortPresentations(); };
  const resume = () => {
    try { if (powerMonitor.getSystemIdleState(1) === "locked") receiver.setLocked(true); } catch { /* best effort */ }
    receiver.setSuspended(false);
  };
  const activity = () => receiver.activityChanged();
  powerMonitor.on("lock-screen", lock); powerMonitor.on("unlock-screen", unlock);
  powerMonitor.on("suspend", suspend); powerMonitor.on("resume", resume);
  app.on("browser-window-focus", activity); app.on("browser-window-blur", activity);
  try { receiver.setLocked(powerMonitor.getSystemIdleState(1) === "locked"); } catch { /* supported platforms only */ }
  return {
    start(account: string) {
      if (disposed || quitting || !currentTicket()) return;
      activeSession = {origin: currentBusinessOrigin(), account, epoch: ticketEpoch(), deviceId: `${getDeviceId()}#im-native`};
      receiver.start(activeSession);
    },
    stop() { activeSession = null; receiver.stop(); },
    snapshot: () => receiver.getSnapshot(),
    retry: () => receiver.retry(),
    setNotificationEnabled(enabled: boolean) {
      notifyEnabled = enabled;
      if (!enabled) abortPresentations();
      writeSetting(ENABLED_KEY, enabled);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      receiver.dispose(); native.dispose();
      powerMonitor.removeListener("lock-screen", lock); powerMonitor.removeListener("unlock-screen", unlock);
      powerMonitor.removeListener("suspend", suspend); powerMonitor.removeListener("resume", resume);
      app.removeListener("browser-window-focus", activity); app.removeListener("browser-window-blur", activity);
    },
  };
}

export function initIMReceiver(getMainWindow: () => BrowserWindow | null): void {
  if (APP_NAME_IDENTIFIER === "nuwax" && !runtime && !quitting) runtime = createRuntime(getMainWindow);
}
export function startIMReceiver(account: string): void { runtime?.start(account); }
export function stopIMReceiver(): void { runtime?.stop(); }
export function disposeIMReceiver(): void { quitting = true; runtime?.dispose(); runtime = null; unreadListeners.clear(); }
export function getIMUnreadSnapshot(): IMUnreadSnapshot | null { return runtime?.snapshot() ?? null; }
export function onIMUnreadChanged(listener: (snapshot: IMUnreadSnapshot | null) => void): () => void {
  unreadListeners.add(listener);
  return () => { unreadListeners.delete(listener); };
}
export function retryIMReceiver(): void { runtime?.retry(); }
export function setIMNotificationEnabled(enabled: boolean): void { runtime?.setNotificationEnabled(enabled); }
