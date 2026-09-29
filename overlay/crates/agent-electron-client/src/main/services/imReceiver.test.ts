import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IMReceiver,
  IMReceiverError,
  type IMReceiverDeps,
  type IMReceiverSession,
  type IMReceiverSocket,
} from "./imReceiver";

const SESSION: IMReceiverSession = {
  origin: "https://im.example.test",
  account: "account-one",
  epoch: 1,
  deviceId: "native-observer-device",
};
type Callbacks = Parameters<IMReceiverDeps["connect"]>[1];
type Unread = Awaited<ReturnType<IMReceiverDeps["unread"]>>;
type Connection = {
  session: IMReceiverSession;
  callbacks: Callbacks;
  socket: IMReceiverSocket & { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
};
const receivers: IMReceiver[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

function harness() {
  let online = true;
  let foreground = true;
  let sessionCurrent = true;
  const connections: Connection[] = [];
  const deps = {
    isOnline: vi.fn(() => online),
    isForeground: vi.fn(() => foreground),
    isSessionCurrent: vi.fn(() => sessionCurrent),
    register: vi.fn<IMReceiverDeps["register"]>().mockResolvedValue(undefined),
    connect: vi.fn<IMReceiverDeps["connect"]>((session, callbacks) => {
      const socket = { send: vi.fn(), close: vi.fn() };
      connections.push({ session, callbacks, socket });
      return socket;
    }),
    unread: vi.fn<IMReceiverDeps["unread"]>().mockResolvedValue({ total: 2, dndTotal: 3, authoritative: true }),
    onUnread: vi.fn<IMReceiverDeps["onUnread"]>(),
    onMessage: vi.fn<IMReceiverDeps["onMessage"]>(),
    onClear: vi.fn(),
    onBlocked: vi.fn(),
    log: vi.fn(),
    now: () => Date.now(),
    random: () => 1,
  } satisfies IMReceiverDeps;
  const receiver = new IMReceiver(deps);
  receivers.push(receiver);
  return {
    receiver, deps, connections,
    setOnline: (value: boolean) => { online = value; },
    setForeground: (value: boolean) => { foreground = value; },
    setSessionCurrent: (value: boolean) => { sessionCurrent = value; },
  };
}

type Harness = ReturnType<typeof harness>;

function packet(connection: Connection, op: number, body: Record<string, unknown> = {}) {
  connection.callbacks.packet({ v: 1, op, body });
}

async function acknowledge(connection: Connection, heartbeatInterval = 300) {
  connection.callbacks.open();
  packet(connection, 1001, { userId: "self-user", heartbeatInterval });
  await vi.advanceTimersByTimeAsync(0);
}

async function login(h: Harness, heartbeatInterval = 300) {
  h.receiver.start(SESSION);
  await flushPromises();
  expect(h.connections).toHaveLength(1);
  const connection = h.connections[0];
  await acknowledge(connection, heartbeatInterval);
  return connection;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  receivers.splice(0).forEach((receiver) => receiver.dispose());
  vi.useRealTimers();
});

describe("IMReceiver: independent session and unread aggregation", () => {
  it("registers and receives without an IM page, preserving both unread components", async () => {
    const h = harness();
    const connection = await login(h);

    expect(h.deps.register).toHaveBeenCalledTimes(1);
    expect(h.deps.register.mock.calls[0][0]).toEqual(SESSION);
    expect(connection.socket.send).toHaveBeenCalledWith(expect.objectContaining({
      v: 1, op: 1000,
      body: { deviceId: SESSION.deviceId, platform: "desktop", lastAckSeq: 0 },
    }));
    expect(h.deps.unread).toHaveBeenCalledTimes(1);
    const snapshot = h.receiver.getSnapshot()!;
    expect(snapshot).toMatchObject({ total: 2, dndTotal: 3 });
    expect(snapshot.total + snapshot.dndTotal).toBe(5);
    snapshot.total = 999;
    expect(h.receiver.getSnapshot()!.total).toBe(2);
    expect(h.deps.onMessage).not.toHaveBeenCalled();
  });

  it("keeps one registration and connection despite repeated starts and refreshes", async () => {
    const h = harness();
    const registration = deferred<void>();
    h.deps.register.mockImplementationOnce(() => registration.promise);
    h.receiver.start(SESSION);
    h.receiver.start({ ...SESSION });
    h.receiver.refresh();
    h.receiver.activityChanged();
    h.receiver.retry();
    expect(h.deps.register).toHaveBeenCalledTimes(1);
    expect(h.connections).toHaveLength(0);

    registration.resolve(undefined);
    await flushPromises();
    await acknowledge(h.connections[0]);
    h.receiver.start({ ...SESSION });
    h.receiver.activityChanged();
    h.receiver.refresh();
    expect(h.deps.connect).toHaveBeenCalledTimes(1);
    expect(h.deps.register).toHaveBeenCalledTimes(1);
  });

  it("ignores a late registration from the previous account", async () => {
    const h = harness();
    const old = deferred<void>();
    const next = deferred<void>();
    h.deps.register.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => next.promise);
    h.receiver.start(SESSION);
    const oldSignal = h.deps.register.mock.calls[0][1];
    const nextSession = { ...SESSION, account: "account-two", epoch: 2 };
    h.receiver.start(nextSession);
    expect(oldSignal.aborted).toBe(true);

    old.resolve(undefined);
    await flushPromises();
    expect(h.deps.connect).not.toHaveBeenCalled();
    next.resolve(undefined);
    await flushPromises();
    expect(h.connections).toHaveLength(1);
    expect(h.connections[0].session).toEqual(nextSession);
    await acknowledge(h.connections[0]);
    expect(h.deps.unread.mock.calls[0][0]).toEqual(nextSession);
  });

  it("isolates late unread results and socket events across account generations", async () => {
    const h = harness();
    const oldUnread = deferred<Unread>();
    const newUnread = deferred<Unread>();
    h.deps.unread.mockImplementationOnce(() => oldUnread.promise).mockImplementationOnce(() => newUnread.promise);
    const oldConnection = await login(h);
    const oldGeneration = h.receiver.getSnapshot()!.sessionGeneration;
    const oldSignal = h.deps.unread.mock.calls[0][1];

    h.receiver.start({ ...SESSION, account: "account-two", origin: "https://other.example.test", epoch: 2 });
    await flushPromises();
    await acknowledge(h.connections[1]);
    expect(oldSignal.aborted).toBe(true);
    expect(h.receiver.isGenerationCurrent(oldGeneration)).toBe(false);
    oldConnection.callbacks.close();
    packet(oldConnection, 3002, { convId: "old-message" });
    oldUnread.resolve({ total: 100, dndTotal: 100 });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.deps.onMessage).not.toHaveBeenCalled();
    expect(h.deps.unread).toHaveBeenCalledTimes(2);
    expect(h.receiver.getSnapshot()!.total).toBe(0);

    newUnread.resolve({ total: 7, dndTotal: 4 });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.receiver.getSnapshot()).toMatchObject({ total: 7, dndTotal: 4 });
    expect(h.deps.connect).toHaveBeenCalledTimes(2);
  });

  it("stops and clears counts when the auth session is no longer current", async () => {
    const h = harness();
    const connection = await login(h);
    h.setSessionCurrent(false);
    h.receiver.refresh();

    expect(connection.socket.close).toHaveBeenCalledTimes(1);
    expect(h.receiver.getSnapshot()).toMatchObject({ total: 0, dndTotal: 0 });
    expect(h.receiver.canReceive()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.deps.connect).toHaveBeenCalledTimes(1);
  });
});

describe("IMReceiver: bounded unread refresh", () => {
  it.each([null, undefined])("uses available total when the existing IM API omits DND counts (%s)", async (dndTotal) => {
    const h = harness();
    await login(h);
    expect(h.receiver.getSnapshot()).toMatchObject({ total: 2, dndTotal: 3 });
    h.deps.unread.mockResolvedValue({ total: 54, dndTotal, authoritative: true });
    h.receiver.refresh();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.receiver.getSnapshot()).toMatchObject({ total: 54, dndTotal: 0 });
    const snapshot = h.receiver.getSnapshot()!;
    expect(snapshot.total + snapshot.dndTotal).toBe(54);
  });

  it.each([3002, 3004, 6000, 6001, 5001])("refreshes unread for invalidation op %s", async (op) => {
    const h = harness();
    const connection = await login(h);
    await vi.advanceTimersByTimeAsync(1_000);
    packet(connection, op, { convId: "one" });
    await vi.advanceTimersByTimeAsync(199);
    expect(h.deps.unread).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.deps.unread).toHaveBeenCalledTimes(2);
    expect(h.deps.onMessage).toHaveBeenCalledTimes(op === 3002 ? 1 : 0);
  });

  it("debounces bursts into one pull", async () => {
    const h = harness();
    const connection = await login(h);
    await vi.advanceTimersByTimeAsync(1_000);
    for (let index = 0; index < 100; index++) packet(connection, 3004);
    await vi.advanceTimersByTimeAsync(199);
    expect(h.deps.unread).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.deps.unread).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.deps.unread).toHaveBeenCalledTimes(2);
  });

  it("performs one dirty tail pull after the only in-flight request settles", async () => {
    const h = harness();
    const inFlight = deferred<Unread>();
    h.deps.unread.mockResolvedValueOnce({ total: 1, dndTotal: 0 })
      .mockImplementationOnce(() => inFlight.promise).mockResolvedValueOnce({ total: 9, dndTotal: 2 });
    const connection = await login(h);
    await vi.advanceTimersByTimeAsync(1_000);
    packet(connection, 3004);
    await vi.advanceTimersByTimeAsync(200);
    for (let index = 0; index < 100; index++) packet(connection, 6000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.deps.unread).toHaveBeenCalledTimes(2);

    inFlight.resolve({ total: 3, dndTotal: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.deps.unread).toHaveBeenCalledTimes(3);
    expect(h.receiver.getSnapshot()).toMatchObject({ total: 9, dndTotal: 2 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.deps.unread).toHaveBeenCalledTimes(3);
  });

  it("uses authoritative=false counts while throttling event refreshes for 60 seconds", async () => {
    const h = harness();
    h.deps.unread.mockResolvedValue({ total: 5, dndTotal: 8, authoritative: false });
    const connection = await login(h);
    expect(h.receiver.getSnapshot()).toMatchObject({ total: 5, dndTotal: 8 });
    expect(h.receiver.canReceive()).toBe(true);
    packet(connection, 3004);
    h.receiver.refresh();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.deps.unread).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.deps.unread).toHaveBeenCalledTimes(2);
  });

  it.each([
    { total: -1, dndTotal: 0 },
    { total: 0, dndTotal: Number.NaN },
    { total: Number.MAX_SAFE_INTEGER, dndTotal: 1 },
  ])("keeps the last successful snapshot for invalid counters %j", async (result) => {
    const h = harness();
    h.deps.unread.mockResolvedValueOnce({ total: 2, dndTotal: 3 }).mockResolvedValueOnce(result);
    const connection = await login(h);
    const snapshot = h.receiver.getSnapshot();
    packet(connection, 3004);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.receiver.getSnapshot()).toEqual(snapshot);
    expect(h.deps.onBlocked).not.toHaveBeenCalled();
  });

  it("keeps the last snapshot on request failure without a tight retry loop", async () => {
    const h = harness();
    h.deps.unread.mockResolvedValueOnce({ total: 2, dndTotal: 3 }).mockRejectedValueOnce(new Error("network request failed"));
    const connection = await login(h);
    const snapshot = h.receiver.getSnapshot();
    packet(connection, 3004);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.deps.unread).toHaveBeenCalledTimes(2);
    expect(h.receiver.getSnapshot()).toEqual(snapshot);
  });

  it.each([true, false])("calibrates unread at the foreground=%s interval", async (foreground) => {
    const h = harness();
    h.setForeground(foreground);
    const connection = await login(h);
    const interval = foreground ? 120_000 : 300_000;
    await vi.advanceTimersByTimeAsync(interval - 1);
    expect(h.deps.unread).toHaveBeenCalledTimes(1);
    packet(connection, 2001);
    // 周期回调再排一个零延时拉取；fake-timer 将新 timer 放到下一 tick。
    await vi.advanceTimersByTimeAsync(2);
    expect(h.deps.unread).toHaveBeenCalledTimes(2);
  });
});

describe("IMReceiver: pause, offline, recovery and connection ownership", () => {
  it.each(["lock", "suspend"] as const)("performs no network work during %s and refreshes without replay on recovery", async (kind) => {
    const h = harness();
    const oldConnection = await login(h);
    packet(oldConnection, 3002, { convId: "before-pause" });
    const [message, generation, isMessageCurrent, selfId] = h.deps.onMessage.mock.calls[0];
    expect(message.convId).toBe("before-pause");
    expect(selfId).toBe("self-user");
    expect(isMessageCurrent()).toBe(true);
    const setPause = kind === "lock" ? h.receiver.setLocked.bind(h.receiver) : h.receiver.setSuspended.bind(h.receiver);

    setPause(true);
    expect(h.receiver.isGenerationCurrent(generation)).toBe(true);
    expect(h.receiver.canReceive()).toBe(false);
    expect(isMessageCurrent()).toBe(false);
    expect(oldConnection.socket.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    h.deps.onMessage.mockClear();
    await vi.advanceTimersByTimeAsync(600_000);
    h.receiver.refresh();
    packet(oldConnection, 3002, { convId: "late-old-message" });
    expect(h.deps.register).toHaveBeenCalledTimes(1);
    expect(h.deps.connect).toHaveBeenCalledTimes(1);
    expect(h.deps.unread).toHaveBeenCalledTimes(1);

    h.deps.unread.mockResolvedValueOnce({ total: 10, dndTotal: 20 });
    setPause(false);
    await flushPromises();
    await acknowledge(h.connections[1]);
    packet(oldConnection, 3002, { convId: "stale-after-resume" });
    expect(isMessageCurrent()).toBe(false);
    expect(h.receiver.canReceive()).toBe(true);
    expect(h.deps.onMessage).not.toHaveBeenCalled();
    expect(h.deps.unread).toHaveBeenCalledTimes(2);
    expect(h.receiver.getSnapshot()).toMatchObject({ total: 10, dndTotal: 20 });
  });

  it("aborts pending registration while locked and ignores its late completion", async () => {
    const h = harness();
    const registration = deferred<void>();
    h.deps.register.mockImplementationOnce(() => registration.promise);
    h.receiver.start(SESSION);
    const signal = h.deps.register.mock.calls[0][1];
    h.receiver.setLocked(true);
    expect(signal.aborted).toBe(true);
    registration.resolve(undefined);
    await flushPromises();
    expect(h.deps.connect).not.toHaveBeenCalled();
    h.receiver.setLocked(false);
    await flushPromises();
    expect(h.deps.register).toHaveBeenCalledTimes(2);
    expect(h.connections).toHaveLength(1);
  });

  it("aborts pending unread on pause and ignores a late response after resuming the same account", async () => {
    const h = harness();
    const oldUnread = deferred<Unread>();
    h.deps.unread.mockImplementationOnce(() => oldUnread.promise).mockResolvedValueOnce({ total: 6, dndTotal: 7 });
    await login(h);
    const signal = h.deps.unread.mock.calls[0][1];
    h.receiver.setSuspended(true);
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    h.receiver.setSuspended(false);
    await flushPromises();
    await acknowledge(h.connections[1]);
    const snapshot = h.receiver.getSnapshot();
    oldUnread.resolve({ total: 100, dndTotal: 100 });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.receiver.getSnapshot()).toEqual(snapshot);
    expect(snapshot).toMatchObject({ total: 6, dndTotal: 7 });
  });

  it("uses one 15-second local online probe while offline and reconnects when online", async () => {
    const h = harness();
    h.setOnline(false);
    h.receiver.start(SESSION);
    expect(vi.getTimerCount()).toBe(1);
    const probes = h.deps.isOnline.mock.calls.length;
    await vi.advanceTimersByTimeAsync(14_999);
    expect(h.deps.isOnline).toHaveBeenCalledTimes(probes);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.deps.isOnline).toHaveBeenCalledTimes(probes + 1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(vi.getTimerCount()).toBe(1);
    expect(h.deps.register).not.toHaveBeenCalled();
    expect(h.deps.connect).not.toHaveBeenCalled();
    expect(h.deps.unread).not.toHaveBeenCalled();

    h.setOnline(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.connections).toHaveLength(1);
    await acknowledge(h.connections[0]);
    expect(h.deps.unread).toHaveBeenCalledTimes(1);
  });

  it.each(["resolve", "reject"] as const)("recovers when pending registration %s occurs after connectivity changes", async (settlement) => {
    const h = harness();
    const registration = deferred<void>();
    h.deps.register.mockImplementationOnce(() => registration.promise);
    h.receiver.start(SESSION);
    h.setOnline(false);
    if (settlement === "resolve") registration.resolve(undefined);
    else registration.reject(new Error("connection lost during registration"));
    await flushPromises();

    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.deps.register).toHaveBeenCalledTimes(1);
    expect(h.deps.connect).not.toHaveBeenCalled();
    h.setOnline(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.deps.register).toHaveBeenCalledTimes(2);
    expect(h.connections).toHaveLength(1);
  });

  it("closes the connected socket when offline is reported without network retries", async () => {
    const h = harness();
    const connection = await login(h);
    h.setOnline(false);
    h.receiver.activityChanged();
    expect(connection.socket.close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.deps.register).toHaveBeenCalledTimes(1);
    expect(h.deps.connect).toHaveBeenCalledTimes(1);
    expect(h.deps.unread).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("enters the local offline probe when an in-flight unread request fails after connectivity changes", async () => {
    const h = harness();
    const unread = deferred<Unread>();
    h.deps.unread.mockImplementationOnce(() => unread.promise);
    const connection = await login(h);
    h.setOnline(false);
    unread.reject(new Error("connection lost"));
    await flushPromises();

    expect(connection.socket.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    const probes = h.deps.isOnline.mock.calls.length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.deps.isOnline).toHaveBeenCalledTimes(probes + 1);
    expect(h.deps.register).toHaveBeenCalledTimes(1);
    expect(h.deps.connect).toHaveBeenCalledTimes(1);
    expect(h.deps.unread).toHaveBeenCalledTimes(1);
  });

  it("enters the offline probe for a successful late unread response and preserves the last good count", async () => {
    const h = harness();
    const unread = deferred<Unread>();
    h.deps.unread.mockResolvedValueOnce({ total: 6, dndTotal: 7 }).mockImplementationOnce(() => unread.promise);
    const connection = await login(h);
    const snapshot = h.receiver.getSnapshot();
    packet(connection, 3004);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.deps.unread).toHaveBeenCalledTimes(2);
    h.setOnline(false);
    unread.resolve({ total: 100, dndTotal: 100 });
    await flushPromises();

    expect(connection.socket.close).toHaveBeenCalledTimes(1);
    expect(h.receiver.getSnapshot()).toEqual(snapshot);
    expect(vi.getTimerCount()).toBe(1);
    const probes = h.deps.isOnline.mock.calls.length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.deps.isOnline).toHaveBeenCalledTimes(probes + 1);
    expect(h.deps.connect).toHaveBeenCalledTimes(1);
    expect(h.deps.unread).toHaveBeenCalledTimes(2);
  });

  it("uses exponentially increasing reconnect delays capped at 30 seconds", async () => {
    const h = harness();
    h.receiver.start(SESSION);
    await flushPromises();
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      const before = h.connections.length;
      h.connections[before - 1].callbacks.close();
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(h.connections).toHaveLength(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.connections).toHaveLength(before + 1);
    }
    expect(h.deps.register).toHaveBeenCalledTimes(1);
    expect(h.deps.unread).not.toHaveBeenCalled();
  });

  it("refetches full unread counts after reconnection and invalidates the previous socket", async () => {
    const h = harness();
    h.deps.unread.mockResolvedValueOnce({ total: 1, dndTotal: 2 }).mockResolvedValueOnce({ total: 8, dndTotal: 9 });
    const oldConnection = await login(h);
    oldConnection.callbacks.close();
    await vi.advanceTimersByTimeAsync(1_000);
    await acknowledge(h.connections[1]);
    packet(oldConnection, 3002, { convId: "old" });
    oldConnection.callbacks.close();
    expect(h.deps.onMessage).not.toHaveBeenCalled();
    expect(h.deps.unread).toHaveBeenCalledTimes(2);
    expect(h.receiver.getSnapshot()).toMatchObject({ total: 8, dndTotal: 9 });
    expect(h.deps.connect).toHaveBeenCalledTimes(2);
  });

  it("reconnects immediately for server_restart but honors stopReconnect", async () => {
    const h = harness();
    const connection = await login(h);
    packet(connection, 9000, { reason: "server_restart" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.connections).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    await acknowledge(h.connections[1]);
    packet(h.connections[1], 9000, { reason: "server_restart", stopReconnect: true });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.deps.connect).toHaveBeenCalledTimes(2);
    expect(h.deps.onBlocked).toHaveBeenCalledWith("server_restart");
  });

  it.each(["auth_expired", "device_kicked", "force_logout"])("blocks terminal KICK %s until explicit retry", async (reason) => {
    const h = harness();
    const connection = await login(h);
    const snapshot = h.receiver.getSnapshot();
    packet(connection, 9000, { reason });
    h.receiver.activityChanged();
    h.receiver.start({ ...SESSION });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.deps.onBlocked).toHaveBeenCalledWith(reason);
    expect(h.deps.connect).toHaveBeenCalledTimes(1);
    expect(h.receiver.canReceive()).toBe(false);
    if (reason === "auth_expired") {
      expect(h.receiver.getSnapshot()).toMatchObject({ total: 0, dndTotal: 0 });
    } else expect(h.receiver.getSnapshot()).toEqual(snapshot);
    expect(vi.getTimerCount()).toBe(0);
    h.receiver.retry();
    await flushPromises();
    expect(h.connections).toHaveLength(2);
  });

  it.each([
    { reason: "auth_expired", op: 9000 },
    { reason: "account_disabled", op: 9000 },
    { reason: "IM_10401", op: 1002 },
    { reason: "IM_10402", op: 1002 },
    { reason: "IM_10403", op: 9001 },
  ])("clears auth-blocked counts and old toast generation for $reason without unlocking the block", async ({ reason, op }) => {
    const h = harness();
    const connection = await login(h);
    packet(connection, 3002, { convId: "old-toast" });
    const [, generation, isToastCurrent] = h.deps.onMessage.mock.calls[0];
    expect(isToastCurrent()).toBe(true);
    const before = h.receiver.getSnapshot()!;
    expect(before.total + before.dndTotal).toBe(5);
    h.deps.onClear.mockClear();
    packet(connection, op, op === 9000 ? { reason } : { code: reason });

    expect(h.receiver.getSnapshot()).toMatchObject({ total: 0, dndTotal: 0 });
    expect(h.receiver.getSnapshot()!.sessionGeneration).toBeGreaterThan(generation);
    expect(h.receiver.getSnapshot()!.revision).toBeGreaterThan(before.revision);
    expect(h.receiver.isGenerationCurrent(generation)).toBe(false);
    expect(isToastCurrent()).toBe(false);
    expect(h.deps.onClear).toHaveBeenCalledTimes(1);
    expect(h.deps.onBlocked).toHaveBeenCalledWith(reason);
    h.receiver.setLocked(true);
    h.receiver.setLocked(false);
    h.receiver.setSuspended(true);
    h.receiver.setSuspended(false);
    h.receiver.activityChanged();
    h.receiver.refresh();
    h.receiver.start({ ...SESSION });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.receiver.canReceive()).toBe(false);
    expect(h.deps.register).toHaveBeenCalledTimes(1);
    expect(h.deps.connect).toHaveBeenCalledTimes(1);
    expect(h.deps.unread).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([1002, 9001])("blocks quota rejection op %s without automatic retries", async (op) => {
    const h = harness();
    const connection = await login(h);
    const snapshot = h.receiver.getSnapshot();
    h.deps.onClear.mockClear();
    packet(connection, op, { code: "IM_10429" });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.deps.onBlocked).toHaveBeenCalledWith("IM_10429");
    expect(h.deps.connect).toHaveBeenCalledTimes(1);
    expect(h.receiver.getSnapshot()).toEqual(snapshot);
    expect(h.deps.onClear).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("blocks a registration quota failure but retries a temporary auth outage", async () => {
    const blocked = harness();
    blocked.deps.register.mockRejectedValue(new IMReceiverError("IM_10429"));
    blocked.receiver.start(SESSION);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(blocked.deps.register).toHaveBeenCalledTimes(1);
    expect(blocked.deps.onBlocked).toHaveBeenCalledWith("IM_10429");

    const temporary = harness();
    temporary.deps.register.mockRejectedValueOnce(new IMReceiverError("IM_10503"));
    temporary.receiver.start(SESSION);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(999);
    expect(temporary.deps.register).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(temporary.deps.register).toHaveBeenCalledTimes(2);
    expect(temporary.connections).toHaveLength(1);
  });
});

describe("IMReceiver: heartbeat and disposal", () => {
  it("reconnects after three missing heartbeat responses without sending read or receive acknowledgements", async () => {
    const h = harness();
    const connection = await login(h, 5);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(connection.socket.send.mock.calls.map(([value]) => (value as { op: number }).op)).toEqual([1000, 2000, 2000]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(connection.socket.close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(h.deps.connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.deps.connect).toHaveBeenCalledTimes(2);
  });

  it("keeps the socket alive while fresh heartbeat responses arrive", async () => {
    const h = harness();
    const connection = await login(h, 5);
    for (let count = 0; count < 5; count++) {
      await vi.advanceTimersByTimeAsync(5_000);
      packet(connection, 2001);
    }
    expect(connection.socket.close).not.toHaveBeenCalled();
    expect(h.deps.connect).toHaveBeenCalledTimes(1);
  });

  it("times out a handshake after 10 seconds and retries once", async () => {
    const h = harness();
    h.receiver.start(SESSION);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(h.connections[0].socket.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.connections[0].socket.close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.connections).toHaveLength(2);
    expect(h.deps.unread).not.toHaveBeenCalled();
  });

  it.each(["connected", "connecting", "reconnect", "offline"] as const)("cleans every timer when disposed from %s", async (state) => {
    const h = harness();
    if (state === "connected") {
      const connection = await login(h);
      packet(connection, 3004);
    } else if (state === "offline") {
      h.setOnline(false);
      h.receiver.start(SESSION);
    } else {
      h.receiver.start(SESSION);
      await flushPromises();
      if (state === "reconnect") h.connections[0].callbacks.close();
    }
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    const registrations = h.deps.register.mock.calls.length;
    const connections = h.deps.connect.mock.calls.length;
    const pulls = h.deps.unread.mock.calls.length;
    h.receiver.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.receiver.getSnapshot()).toMatchObject({ total: 0, dndTotal: 0 });
    h.receiver.start(SESSION);
    h.receiver.retry();
    h.receiver.refresh();
    h.receiver.activityChanged();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(h.deps.register).toHaveBeenCalledTimes(registrations);
    expect(h.deps.connect).toHaveBeenCalledTimes(connections);
    expect(h.deps.unread).toHaveBeenCalledTimes(pulls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts pending requests on disposal and rejects their late completion", async () => {
    const h = harness();
    const unread = deferred<Unread>();
    h.deps.unread.mockImplementationOnce(() => unread.promise);
    const connection = await login(h);
    const signal = h.deps.unread.mock.calls[0][1];
    h.receiver.dispose();
    expect(signal.aborted).toBe(true);
    const snapshot = h.receiver.getSnapshot();
    unread.resolve({ total: 100, dndTotal: 100 });
    packet(connection, 3002, { convId: "late" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.receiver.getSnapshot()).toEqual(snapshot);
    expect(h.deps.onMessage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
