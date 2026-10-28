import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  jar: new Map<string, Record<string, unknown>>(),
  origin: "https://biz.example.com",
  delayNextSet: null as Promise<void> | null,
  delayNextGet: null as Promise<void> | null,
  writeFailures: 0,
  writeFailureMode: "false" as "false" | "throw",
  alwaysFailWrite: false,
  writes: [] as { key: string; value: unknown }[],
  changed: null as null | ((event: unknown, cookie: Record<string, unknown>, cause: string, removed: boolean) => void),
}));
vi.mock("../db", () => ({
  readSetting: (key: string) => mocks.settings.get(key) ?? null,
  writeSetting: (key: string, value: unknown) => {
    if (mocks.alwaysFailWrite || mocks.writeFailures > 0) {
      mocks.writeFailures = Math.max(0, mocks.writeFailures - 1);
      if (mocks.writeFailureMode === "throw") throw new Error("settings unavailable");
      return false;
    }
    mocks.settings.set(key, value);
    mocks.writes.push({ key, value });
    return true;
  },
}));
vi.mock("./commercialSessionScope", () => ({
  currentBusinessOrigin: () => mocks.origin,
  readTicketCookieValue: (scopes: string[]) => {
    for (const origin of scopes) {
      if (mocks.settings.get(`nuwax.ticketSecureHttp.${origin}`)) continue;
      const meta = mocks.settings.get(`nuwax.ticketMeta.${origin}`) as { expirationDate?: number } | undefined;
      if (meta?.expirationDate && meta.expirationDate <= Date.now() / 1000) continue;
      const value = mocks.settings.get(`nuwax.ticket.${origin}`);
      if (typeof value === "string" && value) return value;
    }
    return null;
  },
  NUWAX_TICKET_KEY_PREFIX: "nuwax.ticket.",
}));
vi.mock("electron-log", () => ({ default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock("electron", () => ({
  session: { defaultSession: { cookies: {
    get: vi.fn(async ({ url }: { url: string }) => {
      const cookie = mocks.jar.get(url);
      const delay = mocks.delayNextGet;
      mocks.delayNextGet = null;
      if (delay) await delay;
      return cookie ? [cookie] : [];
    }),
    set: vi.fn(async (cookie: Record<string, unknown>) => {
      const delay = mocks.delayNextSet;
      mocks.delayNextSet = null;
      if (delay) await delay;
      mocks.jar.set(cookie.url as string, cookie);
    }),
    remove: vi.fn(async (url: string) => { mocks.jar.delete(url); }),
    on: vi.fn((_name: string, listener: typeof mocks.changed) => { mocks.changed = listener; }),
  } } },
}));

beforeEach(() => {
  vi.resetModules();
  mocks.settings.clear();
  mocks.jar.clear();
  mocks.origin = "https://biz.example.com";
  mocks.delayNextSet = null;
  mocks.delayNextGet = null;
  mocks.writeFailures = 0;
  mocks.alwaysFailWrite = false;
  mocks.writeFailureMode = "false";
  mocks.writes = [];
  mocks.changed = null;
});

describe("commercial ticket cookie mirror", () => {
  it("mirrors only ticket from multiple raw headers to the configured host and loopback", async () => {
    const api = await import("./commercialTicketSession");
    await api.setLoopbackTicketOrigin("http://127.0.0.1:46800");
    await api.mirrorGatewaySetCookies([
      "other=unrelated; Path=/",
      "ticket=new; Domain=.example.com; Secure; HttpOnly; SameSite=None; Path=/; Max-Age=3600",
    ], mocks.origin, api.ticketEpoch());
    expect(mocks.jar.get(mocks.origin)).toMatchObject({
      name: "ticket", value: "new", httpOnly: true, secure: true,
    });
    expect(mocks.jar.get("http://127.0.0.1:46800")).toMatchObject({
      name: "ticket", value: "new", httpOnly: true, secure: false, sameSite: "lax",
    });
    expect(mocks.settings.get(`nuwax.ticket.${mocks.origin}`)).toBe("new");
    expect(mocks.jar.size).toBe(2);
  });

  it("rejects a Secure backend cookie for an HTTP business domain", async () => {
    mocks.origin = "http://biz.example.com";
    const api = await import("./commercialTicketSession");
    await api.mirrorGatewaySetCookies(["ticket=x; Secure; Path=/"], mocks.origin, api.ticketEpoch());
    expect(api.currentTicket()).toBeNull();
    expect(mocks.jar.size).toBe(0);
    mocks.jar.set("http://127.0.0.1:46800", { name: "ticket", value: "x" });
    expect(await api.syncTicketFromJar("http://127.0.0.1:46800")).toBe(false);
  });

  it("ignores late renewal after logout and handles expiry deletion", async () => {
    const api = await import("./commercialTicketSession");
    const gateway = "http://127.0.0.1:46800";
    await api.setLoopbackTicketOrigin(gateway);
    const old = api.ticketEpoch();
    api.invalidateTicketSession([mocks.origin]);
    await api.mirrorGatewaySetCookies(["ticket=late; Path=/"], mocks.origin, old);
    expect(api.currentTicket()).toBeNull();
    await api.mirrorGatewaySetCookies(["ticket=fresh; Path=/"], mocks.origin, api.ticketEpoch());
    const beforeClear = api.ticketEpoch();
    await api.mirrorGatewaySetCookies(["ticket=; Max-Age=0; Path=/"], mocks.origin, beforeClear);
    expect(api.currentTicket()).toBeNull();
    expect(mocks.jar.has(mocks.origin)).toBe(false);
    expect(mocks.jar.has(gateway)).toBe(false);
    expect(api.ticketEpoch()).toBeGreaterThan(beforeClear);
    await api.mirrorGatewaySetCookies(["ticket=stale; Path=/"], mocks.origin, beforeClear);
    expect(api.currentTicket()).toBeNull();
    await api.mirrorGatewaySetCookies(["ticket=new; Path=/"], mocks.origin, api.ticketEpoch());
    await api.mirrorGatewaySetCookies(["ticket=; Path=/"], mocks.origin, api.ticketEpoch());
    expect(mocks.jar.size).toBe(0);
  });

  it("serializes a delayed update before a later empty Set-Cookie", async () => {
    const api = await import("./commercialTicketSession");
    let release!: () => void;
    mocks.delayNextSet = new Promise<void>((resolve) => { release = resolve; });
    const requestEpoch = api.ticketEpoch();
    const update = api.mirrorGatewaySetCookies(["ticket=old; Path=/"], mocks.origin, requestEpoch);
    await vi.waitFor(() => expect(mocks.delayNextSet).toBeNull());
    const clear = api.mirrorGatewaySetCookies(["ticket=; Path=/"], mocks.origin, requestEpoch);
    release();
    await Promise.all([update, clear]);
    expect(api.currentTicket()).toBeNull();
    expect(mocks.jar.has(mocks.origin)).toBe(false);
  });

  it("uses the last valid ticket in a response for both explicit jars", async () => {
    const api = await import("./commercialTicketSession");
    const gateway = "http://127.0.0.1:46800";
    await api.setLoopbackTicketOrigin(gateway);
    expect(await api.mirrorGatewaySetCookies([
      "ticket=; Max-Age=0; Path=/",
      "ticket=last; Secure; SameSite=None; Path=/",
      "ticket=foreign; Domain=foreign.example; Path=/",
    ], mocks.origin, api.ticketEpoch())).toBe(true);
    expect(api.currentTicket()).toBe("last");
    expect(mocks.jar.get(gateway)?.value).toBe("last");
  });

  it("does not persist a late cookie write after mirror abort and clears its jar", async () => {
    const api = await import("./commercialTicketSession");
    const gateway = "http://127.0.0.1:46800";
    await api.setLoopbackTicketOrigin(gateway);
    let release!: () => void;
    mocks.delayNextSet = new Promise<void>((resolve) => { release = resolve; });
    const mirror = api.mirrorGatewaySetCookies(["ticket=late; Path=/"], mocks.origin, api.ticketEpoch());
    await vi.waitFor(() => expect(mocks.delayNextSet).toBeNull());
    api.abortGatewayTicketMirror(mocks.origin);
    expect(api.currentTicket()).toBeNull();
    release();
    expect(await mirror).toBe(false);
    await vi.waitFor(() => expect(mocks.jar.size).toBe(0));
    expect(mocks.settings.get(`nuwax.ticket.${mocks.origin}`)).toBeNull();
  });

  it("rejects failed gateway settings writes and queues jar cleanup even if DB deletes fail", async () => {
    const api = await import("./commercialTicketSession");
    await api.mirrorGatewaySetCookies(["ticket=old; Path=/"], mocks.origin, api.ticketEpoch());
    mocks.alwaysFailWrite = true;
    mocks.writeFailureMode = "throw";
    await expect(api.mirrorGatewaySetCookies(["ticket=new; Path=/"], mocks.origin, api.ticketEpoch())).rejects.toThrow();
    expect(mocks.settings.get(`nuwax.ticket.${mocks.origin}`)).toBe("old");
    expect(api.currentTicket()).toBeNull();
    expect(() => api.abortGatewayTicketMirror(mocks.origin)).not.toThrow();
    await vi.waitFor(() => expect(mocks.jar.size).toBe(0));
    expect(api.currentTicket()).toBeNull();
  });

  it("restores a persisted session and records direct-mode cookie rotation", async () => {
    mocks.settings.set(`nuwax.ticket.${mocks.origin}`, "stored");
    const api = await import("./commercialTicketSession");
    await api.restoreTicketSession(null);
    expect(mocks.jar.get(mocks.origin)?.value).toBe("stored");
    mocks.jar.set(mocks.origin, { name: "ticket", domain: "biz.example.com", value: "rotated", path: "/", secure: true });
    mocks.changed?.({}, { name: "ticket", domain: "biz.example.com", value: "rotated" }, "explicit", false);
    await vi.waitFor(() => expect(api.currentTicket()).toBe("rotated"));
  });

  it("drops a stale direct read when another changed event arrives during cookies.get", async () => {
    const api = await import("./commercialTicketSession");
    await api.restoreTicketSession(null);
    let release!: () => void;
    mocks.delayNextGet = new Promise<void>((resolve) => { release = resolve; });
    mocks.jar.set(mocks.origin, { name: "ticket", value: "first", path: "/", secure: true });
    mocks.changed?.({}, { name: "ticket", domain: "biz.example.com", value: "first" }, "explicit", false);
    await vi.waitFor(() => expect(mocks.delayNextGet).toBeNull());
    mocks.jar.set(mocks.origin, { name: "ticket", value: "last", path: "/", secure: true });
    mocks.changed?.({}, { name: "ticket", domain: "biz.example.com", value: "last" }, "explicit", false);
    release();
    await vi.waitFor(() => expect(api.currentTicket()).toBe("last"));
    expect(mocks.writes.some(({ key, value }) => key === `nuwax.ticket.${mocks.origin}` && value === "first")).toBe(false);
  });

  it("keeps the mirror during a slow unknown removal-to-insertion replacement", async () => {
    const api = await import("./commercialTicketSession");
    await api.restoreTicketSession(null);
    await api.mirrorGatewaySetCookies(["ticket=old; Path=/"], mocks.origin, api.ticketEpoch());
    const before = api.ticketEpoch();
    mocks.jar.delete(mocks.origin);
    mocks.changed?.({}, { name: "ticket", domain: "biz.example.com", value: "old" }, "unknown", true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(api.currentTicket()).toBe("old");
    expect(api.ticketEpoch()).toBe(before);
    mocks.jar.set(mocks.origin, { name: "ticket", value: "new", path: "/", secure: true });
    mocks.changed?.({}, { name: "ticket", domain: "biz.example.com", value: "new" }, "explicit", false);
    await vi.waitFor(() => expect(api.currentTicket()).toBe("new"));
    expect(api.ticketEpoch()).toBe(before);
  });

  it("returns false for DB boolean failure and retries background direct synchronization", async () => {
    const api = await import("./commercialTicketSession");
    await api.restoreTicketSession(null);
    mocks.jar.set(mocks.origin, { name: "ticket", value: "new", path: "/", secure: true });
    mocks.writeFailures = 1;
    expect(await api.syncTicketFromJar(mocks.origin)).toBe(false);
    expect(api.currentTicket()).toBeNull();
    mocks.writeFailures = 1;
    mocks.changed?.({}, { name: "ticket", domain: "biz.example.com", value: "new" }, "explicit", false);
    await vi.waitFor(() => expect(api.currentTicket()).toBe("new"));
  });

  it("blocks an old DB mirror when both update and cleanup writes throw", async () => {
    const api = await import("./commercialTicketSession");
    mocks.settings.set(`nuwax.ticket.${mocks.origin}`, "old");
    mocks.jar.set(mocks.origin, { name: "ticket", value: "new", path: "/", secure: true });
    mocks.alwaysFailWrite = true;
    mocks.writeFailureMode = "throw";
    expect(await api.syncTicketFromJar(mocks.origin)).toBe(false);
    expect(mocks.settings.get(`nuwax.ticket.${mocks.origin}`)).toBe("old");
    expect(api.currentTicket()).toBeNull();
  });

  it("reconciles a transient unknown removal while the gateway still holds the ticket", async () => {
    const api = await import("./commercialTicketSession");
    const gateway = "http://127.0.0.1:46800";
    await api.setLoopbackTicketOrigin(gateway);
    await api.restoreTicketSession(gateway);
    await api.mirrorGatewaySetCookies(["ticket=fresh; Path=/"], mocks.origin, api.ticketEpoch());
    mocks.jar.delete(mocks.origin);
    mocks.changed?.({}, { name: "ticket", domain: "biz.example.com", value: "fresh" }, "unknown", true);
    await vi.waitFor(() => expect(mocks.jar.get(mocks.origin)?.value).toBe("fresh"));
    expect(api.currentTicket()).toBe("fresh");
  });

  it("still expires a direct session after a real cookie removal", async () => {
    const api = await import("./commercialTicketSession");
    await api.restoreTicketSession(null);
    await api.mirrorGatewaySetCookies(["ticket=fresh; Path=/"], mocks.origin, api.ticketEpoch());
    const beforeClear = api.ticketEpoch();
    mocks.jar.delete(mocks.origin);
    mocks.changed?.({}, { name: "ticket", domain: "biz.example.com", value: "fresh" }, "expired", true);
    await vi.waitFor(() => expect(api.currentTicket()).toBeNull());
    expect(api.ticketEpoch()).toBeGreaterThan(beforeClear);
  });

  it("treats a direct Set-Cookie with an empty value as logout", async () => {
    const api = await import("./commercialTicketSession");
    await api.restoreTicketSession(null);
    await api.mirrorGatewaySetCookies(["ticket=fresh; Path=/"], mocks.origin, api.ticketEpoch());
    const beforeClear = api.ticketEpoch();
    mocks.jar.set(mocks.origin, { name: "ticket", domain: "biz.example.com", value: "", path: "/" });
    mocks.changed?.({}, { name: "ticket", domain: "biz.example.com", value: "" }, "explicit", false);
    await vi.waitFor(() => expect(api.currentTicket()).toBeNull());
    expect(mocks.jar.has(mocks.origin)).toBe(false);
    expect(api.ticketEpoch()).toBeGreaterThan(beforeClear);
  });

  it("clears legacy Electron cookies once on client upgrade", async () => {
    mocks.settings.set("nuwax.cookieAuthMustRelogin", true);
    mocks.jar.set(mocks.origin, { name: "ticket", value: "legacy" });
    const api = await import("./commercialTicketSession");
    await api.restoreTicketSession(null);
    expect(mocks.jar.has(mocks.origin)).toBe(false);
    expect(mocks.settings.get("nuwax.cookieAuthMustRelogin")).toBeNull();
  });

  it("clears the previous jar cookie before a new login can reuse it", async () => {
    const api = await import("./commercialTicketSession");
    await api.mirrorGatewaySetCookies(["ticket=old; Path=/"], mocks.origin, api.ticketEpoch());
    api.invalidateTicketSession([mocks.origin]);
    await api.clearTicketCookies([mocks.origin]);
    expect(await api.syncTicketFromJar(mocks.origin)).toBe(false);
    expect(api.currentTicket()).toBeNull();
  });
});
