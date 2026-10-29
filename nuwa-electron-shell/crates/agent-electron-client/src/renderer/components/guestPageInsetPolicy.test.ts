import { describe, expect, it } from "vitest";
import {
  resolveGuestPageTopInset,
  resolveHostToolbarHeight,
} from "./guestPageInsetPolicy";

describe("guest 页面顶部退让", () => {
  it.each([
    ["MacIntel", 48],
    ["Win32", 28],
    ["Linux x86_64", 28],
  ])("收银台在 %s 下与宿主工具栏等高", (platform, height) => {
    expect(resolveHostToolbarHeight(platform)).toBe(height);
    expect(
      resolveGuestPageTopInset("https://pay.nuwax.com/cashier/order", platform),
    ).toBe(height);
  });

  it("返回站内或进入未登记页面时取消退让", () => {
    expect(resolveGuestPageTopInset("https://nuwax.com/home", "Win32")).toBe(
      0,
    );
    expect(resolveGuestPageTopInset("https://other.example/pay", "Win32")).toBe(
      0,
    );
    expect(
      resolveGuestPageTopInset("https://pay.nuwax.com.evil.example", "Win32"),
    ).toBe(0);
    expect(resolveGuestPageTopInset("", "MacIntel")).toBe(0);
  });
});
