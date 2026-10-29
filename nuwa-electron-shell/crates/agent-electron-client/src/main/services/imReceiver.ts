import type { IMUnreadSnapshot } from "@shared/types/imReceiver";

/** 只收取通知的独立设备：不发 READ_REPORT/MSG_RECV_ACK，不获取消息历史。 */
export interface IMReceiverSession {
  origin: string;
  account: string;
  epoch: number;
  deviceId: string;
}
export interface IMReceiverSocket {
  send(packet: object): void;
  close(): void;
}
export interface IMReceiverDeps {
  isOnline(): boolean;
  isForeground(): boolean;
  isSessionCurrent(session: IMReceiverSession): boolean;
  register(session: IMReceiverSession, signal: AbortSignal): Promise<void>;
  connect(session: IMReceiverSession, callbacks: {
    isCurrent(): boolean;
    open(): void;
    packet(packet: Record<string, any>): void;
    close(): void;
  }): IMReceiverSocket;
  unread(session: IMReceiverSession, signal: AbortSignal): Promise<{total: number; dndTotal?: number | null; authoritative?: boolean}>;
  onUnread(snapshot: IMUnreadSnapshot): void;
  onMessage(message: Record<string, any>, generation: number, isCurrent: () => boolean, selfId: string): void;
  onClear(): void;
  onBlocked?(reason: string): void;
  log?(state: string): void;
  now?: () => number;
  random?: () => number;
}
const INVALIDATIONS = new Set([3002, 3004, 6000, 6001, 5001]);
const RETRY_CODES = new Set(["IM_10503", "IM_90002"]);
const AUTH_BLOCKS = new Set(["IM_10401", "IM_10402", "IM_10403", "auth_expired", "account_disabled"]);
export class IMReceiverError extends Error {
  constructor(public readonly code: string) { super(code); }
}
const nonNegativeCount = (value: number) => Number.isSafeInteger(value) && value >= 0;

export class IMReceiver {
  private session: IMReceiverSession | null = null;
  private generation = 0;
  private revision = 0;
  private snapshot: IMUnreadSnapshot | null = null;
  private socket: IMReceiverSocket | null = null;
  private registered = false;
  private connecting = false;
  private connected = false;
  private blocked = false;
  private disposed = false;
  private locked = false;
  private suspended = false;
  private connectionRun = 0;
  private attempts = 0;
  private requestSequence = 0;
  private heartbeatMs = 30_000;
  private lastPong = 0;
  private selfId = "";
  private lastPull = -Infinity;
  private pullMinMs = 1_000;
  private dirty = false;
  private connectingAbort: AbortController | null = null;
  private pullAbort: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private pullTimer: ReturnType<typeof setTimeout> | null = null;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private onlineTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: IMReceiverDeps) {}
  private now() { return this.deps.now?.() ?? Date.now(); }
  getSnapshot(): IMUnreadSnapshot | null { return this.snapshot && {...this.snapshot}; }
  isGenerationCurrent(generation: number): boolean {
    return generation === this.generation && this.validSession();
  }
  canReceive(): boolean { return this.canRun(); }
  private validSession(): boolean {
    return !!this.session && !this.disposed && this.deps.isSessionCurrent(this.session);
  }
  private canRun(): boolean {
    return this.validSession() && !this.locked && !this.suspended && !this.blocked && this.deps.isOnline();
  }
  start(session: IMReceiverSession): void {
    if (this.disposed) return;
    if (this.session && this.session.origin === session.origin && this.session.account === session.account &&
        this.session.epoch === session.epoch && this.session.deviceId === session.deviceId) {
      this.reconcile();
      return;
    }
    this.stop();
    this.session = {...session};
    this.registered = false;
    this.selfId = "";
    this.blocked = false;
    this.attempts = 0;
    this.lastPull = -Infinity;
    this.pullMinMs = 1_000;
    this.reconcile();
  }
  stop(): void {
    this.generation++;
    this.session = null;
    this.release();
    this.blocked = false;
    this.registered = false;
    this.snapshot = {sessionGeneration: this.generation, revision: ++this.revision, total: 0, dndTotal: 0};
    this.deps.onClear();
    this.deps.onUnread({...this.snapshot});
  }
  dispose(): void { this.stop(); this.disposed = true; }
  setLocked(locked: boolean): void { this.locked = locked; this.reconcile(); }
  setSuspended(suspended: boolean): void { this.suspended = suspended; this.reconcile(); }
  retry(): void {
    if (!this.validSession()) return;
    this.blocked = false;
    this.attempts = 0;
    this.clearTimer("reconnectTimer");
    this.reconcile();
  }
  refresh(): void {
    if (this.canRun()) this.queuePull();
    else this.reconcile();
  }
  activityChanged(): void {
    this.reconcile();
    if (this.connected) { this.queuePull(); this.scheduleFallback(); }
  }
  private clearTimer(key: "reconnectTimer" | "heartbeatTimer" | "handshakeTimer" | "pullTimer" | "fallbackTimer" | "onlineTimer"): void {
    if (this[key]) clearTimeout(this[key]!);
    this[key] = null;
  }
  private release(): void {
    this.connectionRun++;
    for (const key of ["reconnectTimer", "heartbeatTimer", "handshakeTimer", "pullTimer", "fallbackTimer", "onlineTimer"] as const) this.clearTimer(key);
    this.connectingAbort?.abort(); this.connectingAbort = null;
    this.pullAbort?.abort(); this.pullAbort = null;
    this.dirty = false;
    this.connecting = false;
    this.connected = false;
    const socket = this.socket;
    this.socket = null;
    try { socket?.close(); } catch { /* The transport may already be closed. */ }
  }
  private reconcile(): void {
    if (!this.validSession()) {
      if (this.session) this.stop();
      return;
    }
    if (this.locked || this.suspended || this.blocked) { this.release(); return; }
    if (!this.deps.isOnline()) {
      this.release();
      this.onlineTimer = setTimeout(() => { this.onlineTimer = null; this.reconcile(); }, 15_000);
      return;
    }
    this.clearTimer("onlineTimer");
    if (this.connected || this.connecting || this.reconnectTimer) return;
    void this.open();
  }
  private packet(op: number, body?: object): object {
    return {v: 1, op, reqId: `native-${++this.requestSequence}`, ts: this.now(), ...(body ? {body} : {})};
  }
  private async open(): Promise<void> {
    if (!this.canRun() || this.connecting || this.socket) return;
    const session = this.session!;
    const generation = this.generation;
    const run = ++this.connectionRun;
    const sameRun = () => generation === this.generation && run === this.connectionRun && this.validSession();
    const current = () => sameRun() && this.canRun();
    this.connecting = true;
    const abort = new AbortController();
    this.connectingAbort = abort;
    try {
      if (!this.registered) await this.deps.register(session, abort.signal);
      if (!current()) { if (sameRun()) this.reconcile(); return; }
      this.registered = true;
      this.connectingAbort = null;
      this.socket = this.deps.connect(session, {
        isCurrent: current,
        open: () => {
          if (!current()) { if (sameRun()) this.reconcile(); return; }
          try { this.socket?.send(this.packet(1000, {deviceId: session.deviceId, platform: "desktop", lastAckSeq: 0})); }
          catch { this.disconnected(); }
        },
        packet: (packet) => { if (current()) this.received(packet); else if (sameRun()) this.reconcile(); },
        close: () => { if (current()) this.disconnected(); else if (sameRun()) this.reconcile(); },
      });
      this.handshakeTimer = setTimeout(() => {
        this.handshakeTimer = null;
        if (current()) this.disconnected(); else if (sameRun()) this.reconcile();
      }, 10_000);
    } catch (error) {
      if (!sameRun()) return;
      if (!this.canRun()) { this.reconcile(); return; }
      this.connectingAbort = null;
      if (error instanceof IMReceiverError && !RETRY_CODES.has(error.code)) this.block(error.code);
      else this.disconnected();
    }
  }
  private received(packet: Record<string, any>): void {
    if (packet.v !== 1) { this.block("IM_10001"); return; }
    const body = packet.body && typeof packet.body === "object" ? packet.body : {};
    if (packet.op === 1001) {
      this.clearTimer("handshakeTimer");
      this.connecting = false;
      this.connected = true;
      this.attempts = 0;
      const seconds = Number(body.heartbeatInterval);
      this.heartbeatMs = Number.isFinite(seconds) && seconds >= 5 && seconds <= 300 ? seconds * 1_000 : 30_000;
      this.lastPong = this.now();
      this.selfId = body.userId === undefined ? "" : String(body.userId);
      this.armHeartbeat();
      this.queuePull(0);
      this.scheduleFallback();
      this.deps.log?.("connected");
      return;
    }
    if (packet.op === 2001) { this.lastPong = this.now(); return; }
    if (packet.op === 9000) {
      if (body.reason === "server_restart" && body.stopReconnect !== true) {
        this.disconnected(true);
      } else this.block(String(body.reason || "unknown_kick"));
      return;
    }
    if (packet.op === 1002 || packet.op === 9001) {
      const code = String(packet.code || body.code || "unknown_reject");
      if (RETRY_CODES.has(code)) this.disconnected(); else this.block(code);
      return;
    }
    if (!this.connected) return;
    if (INVALIDATIONS.has(packet.op)) {
      this.queuePull();
      if (packet.op === 3002) {
        const generation = this.generation;
        const run = this.connectionRun;
        this.deps.onMessage(body, generation, () => run === this.connectionRun && this.isGenerationCurrent(generation) && this.canRun(), this.selfId);
      }
    }
  }
  private armHeartbeat(): void {
    this.clearTimer("heartbeatTimer");
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null;
      if (!this.canRun()) { this.reconcile(); return; }
      if (this.now() - this.lastPong >= this.heartbeatMs * 3) { this.disconnected(); return; }
      try { this.socket?.send(this.packet(2000)); }
      catch { this.disconnected(); return; }
      this.armHeartbeat();
    }, this.heartbeatMs);
  }
  private block(reason: string): void {
    this.blocked = true;
    this.release();
    if (AUTH_BLOCKS.has(reason)) {
      // An expired/disabled IM session cannot keep a stale badge or valid toast callback.
      this.generation++;
      this.registered = false;
      this.snapshot = {sessionGeneration: this.generation, revision: ++this.revision, total: 0, dndTotal: 0};
      this.deps.onClear();
      this.deps.onUnread({...this.snapshot});
    }
    this.deps.log?.(`blocked:${reason}`);
    this.deps.onBlocked?.(reason);
  }
  private disconnected(immediate = false): void {
    this.release();
    if (!this.canRun()) { this.reconcile(); return; }
    const backoff = Math.min(30_000, 1_000 * 2 ** Math.min(this.attempts++, 5));
    const random = this.deps.random?.() ?? Math.random();
    const delay = immediate ? 0 : Math.round(backoff * (0.75 + 0.25 * random));
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.reconcile(); }, delay);
    this.deps.log?.("reconnecting");
  }
  private scheduleFallback(): void {
    this.clearTimer("fallbackTimer");
    if (!this.connected || !this.canRun()) return;
    this.fallbackTimer = setTimeout(() => {
      this.fallbackTimer = null;
      this.queuePull(0);
      this.scheduleFallback();
    }, this.deps.isForeground() ? 120_000 : 300_000);
  }
  private queuePull(delay = 200): void {
    if (!this.connected || !this.canRun()) return;
    this.dirty = true;
    if (this.pullAbort || this.pullTimer) return;
    const generation = this.generation;
    const run = this.connectionRun;
    const wait = Math.max(delay, this.lastPull + this.pullMinMs - this.now());
    this.pullTimer = setTimeout(() => {
      this.pullTimer = null;
      if (generation === this.generation && run === this.connectionRun) void this.pull();
    }, wait);
  }
  private async pull(): Promise<void> {
    if (!this.canRun() || !this.connected || this.pullAbort) return;
    const session = this.session!;
    const generation = this.generation;
    const run = this.connectionRun;
    const sameRun = () => generation === this.generation && run === this.connectionRun && this.validSession();
    const current = () => sameRun() && this.canRun();
    const abort = new AbortController();
    this.pullAbort = abort;
    this.dirty = false;
    this.lastPull = this.now();
    try {
      const result = await this.deps.unread(session, abort.signal);
      if (!current()) { if (sameRun() && !this.deps.isOnline()) this.reconcile(); return; }
      // 现有 IM 契约允许免打扰统计为空；此时保留服务端给出的 total。
      const dndTotal = result.dndTotal ?? 0;
      if (!nonNegativeCount(result.total) || !nonNegativeCount(dndTotal) ||
          !Number.isSafeInteger(result.total + dndTotal)) throw new Error("Invalid IM unread result");
      this.pullMinMs = result.authoritative === false ? 60_000 : 1_000;
      const next = {sessionGeneration: generation, revision: ++this.revision, total: result.total, dndTotal};
      this.snapshot = next;
      this.deps.onUnread({...next});
    } catch (error) {
      if (current() && error instanceof IMReceiverError && !RETRY_CODES.has(error.code)) this.block(error.code);
      // 无网络时进入离线探针；其它错误保留最后成功计数，不立即循环请求。
      else if (sameRun() && !this.deps.isOnline()) this.reconcile();
    } finally {
      if (this.pullAbort === abort) {
        this.pullAbort = null;
        if (current() && this.dirty) this.queuePull(0);
      }
    }
  }
}
