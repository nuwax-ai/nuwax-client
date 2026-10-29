import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTicketSetCookie } from "./ticketCookiePolicy";

const BUSINESS_ORIGIN = "https://biz.example.com";

afterEach(() => vi.useRealTimers());

describe("ticket Set-Cookie policy", () => {
  it("uses the same lifetime and attributes for the business ticket and loopback header", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T00:00:00Z"));
    const parsed = parseTicketSetCookie(
      "ticket=T; Domain=.example.com; Secure; SameSite=None; Path=/api; Max-Age=3600",
      BUSINESS_ORIGIN,
    );
    expect(parsed.kind).toBe("valid");
    if (parsed.kind !== "valid") return;
    expect(parsed.ticket).toMatchObject({
      value: "T", path: "/api", secure: true, httpOnly: true,
      sameSite: "no_restriction", expirationDate: Date.now() / 1000 + 3600,
    });
    expect(parsed.loopbackHeader).toBe("ticket=T; Path=/api; Max-Age=3600; SameSite=Lax; HttpOnly");
  });

  it.each([
    ["ticket=T; Domain=evil.example", BUSINESS_ORIGIN],
    ["ticket=T; Domain=.example.com; Domain=biz.example.com", BUSINESS_ORIGIN],
    ["ticket=T; Secure; Partitioned", BUSINESS_ORIGIN],
    ["ticket=T; Secure", "http://biz.example.com"],
    ["ticket=T; Max-Age=not-a-number", BUSINESS_ORIGIN],
    ["ticket=T; Path=api", BUSINESS_ORIGIN],
    ["ticket=unsafe,value", BUSINESS_ORIGIN],
  ])("rejects a ticket whose browser and mirror interpretation cannot agree: %s", (header, origin) => {
    expect(parseTicketSetCookie(header, origin).kind).toBe("invalid");
  });

  it.each([
    "ticket=T; Max-Age=60; Expires=Wed, 01 Jan 2020 00:00:00 GMT",
    "ticket=T; Expires=Wed, 01 Jan 2020 00:00:00 GMT; Max-Age=60",
  ])("honors Max-Age over Expires regardless of attribute order", (header) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T00:00:00Z"));
    const parsed = parseTicketSetCookie(header, BUSINESS_ORIGIN);
    expect(parsed.kind).toBe("valid");
    if (parsed.kind === "valid") expect(parsed.ticket.expirationDate).toBe(Date.now() / 1000 + 60);
  });

  it("keeps an expiry header valid so both destinations can delete the ticket", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T00:00:00Z"));
    const parsed = parseTicketSetCookie("ticket=; Max-Age=0", BUSINESS_ORIGIN);
    expect(parsed.kind).toBe("valid");
    if (parsed.kind !== "valid") return;
    expect(parsed.ticket.value).toBe("");
    expect(parsed.ticket.expirationDate).toBe(Date.now() / 1000);
    expect(parsed.loopbackHeader).toContain("Max-Age=0");
  });

  it("normalizes the final SameSite attribute consistently", () => {
    const parsed = parseTicketSetCookie("ticket=T; SameSite=Strict; SameSite=None", BUSINESS_ORIGIN);
    expect(parsed.kind).toBe("valid");
    if (parsed.kind !== "valid") return;
    expect(parsed.ticket.sameSite).toBe("no_restriction");
    expect(parsed.loopbackHeader).toContain("SameSite=Lax");
  });

  it("leaves unrelated cookies outside the ticket policy", () => {
    expect(parseTicketSetCookie("lang=zh-CN; HttpOnly", BUSINESS_ORIGIN)).toEqual({ kind: "other" });
  });
});
