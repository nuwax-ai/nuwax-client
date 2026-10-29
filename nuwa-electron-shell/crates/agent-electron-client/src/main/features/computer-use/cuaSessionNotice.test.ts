import { afterEach, describe, expect, it } from "vitest";
import {
  CUA_DISABLED_NOTICE,
  CUA_ENABLED_NOTICE,
  applyCuaCapabilityNotice,
  peekCuaCapabilityNotice,
  publishCuaCapabilityNotice,
  resetCuaCapabilityNotice,
} from "./cuaSessionNotice";

afterEach(() => resetCuaCapabilityNotice());

describe("cuaSessionNotice", () => {
  it("publishes the closed-session instruction once per revision", () => {
    expect(CUA_DISABLED_NOTICE).toContain("Computer Use 已关闭");
    expect(CUA_DISABLED_NOTICE).toContain("不要再调用");
    expect(CUA_DISABLED_NOTICE).toContain("`cua`");
    expect(CUA_ENABLED_NOTICE).toContain("已重新开启");

    const first = publishCuaCapabilityNotice(CUA_DISABLED_NOTICE);
    expect(peekCuaCapabilityNotice(0)?.text).toBe(CUA_DISABLED_NOTICE);
    expect(peekCuaCapabilityNotice(first)).toBeNull();

    const applied = applyCuaCapabilityNotice([{ type: "text", text: "hello" }], 0);
    expect(applied.parts.map((part) => part.text)).toEqual([CUA_DISABLED_NOTICE, "hello"]);
    expect(applied.revision).toBe(first);
    expect(applyCuaCapabilityNotice([{ type: "text", text: "again" }], first).parts)
      .toEqual([{ type: "text", text: "again" }]);
  });

  it("replaces a closed notice with a re-enable notice", () => {
    publishCuaCapabilityNotice(CUA_DISABLED_NOTICE);
    const enabled = publishCuaCapabilityNotice(CUA_ENABLED_NOTICE);
    expect(peekCuaCapabilityNotice(0)?.text).toBe(CUA_ENABLED_NOTICE);
    expect(peekCuaCapabilityNotice(enabled - 1)?.revision).toBe(enabled);
  });
});
