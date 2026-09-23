import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  jar: new Map<string, Record<string, unknown>>(),
  origin: "https://biz.example.com",
  changed: null as null | ((event: unknown, cookie: Record<string, unknown>, cause: string, removed: boolean) => void),
}));
vi.mock("../db", () => ({
  readSetting: (key: string) => mocks.settings.get(key) ?? null,
  writeSetting: (key: string, value: unknown) => mocks.settings.set(key, value),
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
vi.mock("electron-log", () => ({ default: { error: vi.fn() } }));
vi.mock("electron", () => ({
  session: { defaultSession: { cookies: {
    get: vi.fn(async ({ url }: { url: string }) => {
      const cookie = mocks.jar.get(url);
      return cookie ? [cookie] : [];
    }),
    set: vi.fn(async (cookie: Record<string, unknown>) => { mocks.jar.set(cookie.url as string, cookie); }),
    remove: vi.fn(async (url: string) => { mocks.jar.delete(url); }),
    on: vi.fn((_name: string, listener: typeof mocks.changed) => { mocks.changed = listener; }),
  } } },
}));

beforeEach(() => {
  vi.resetModules();
  mocks.settings.clear();
  mocks.jar.clear();
  mocks.origin = "https://biz.example.com";
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
    const old = api.ticketEpoch();
    api.invalidateTicketSession([mocks.origin]);
    await api.mirrorGatewaySetCookies(["ticket=late; Path=/"], mocks.origin, old);
    expect(api.currentTicket()).toBeNull();
    await api.mirrorGatewaySetCookies(["ticket=fresh; Path=/"], mocks.origin, api.ticketEpoch());
    await api.mirrorGatewaySetCookies(["ticket=; Max-Age=0; Path=/"], mocks.origin, api.ticketEpoch());
    expect(api.currentTicket()).toBeNull();
    expect(mocks.jar.has(mocks.origin)).toBe(false);
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
