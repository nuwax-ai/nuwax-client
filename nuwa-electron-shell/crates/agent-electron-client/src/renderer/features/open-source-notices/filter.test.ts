/**
 * 单元测试: 开源组件声明列表的纯逻辑
 *
 * 覆盖：搜索（名称/版本/许可证/id、大小写、空查询、无命中）；排序（名称不区分大小写、
 * 同名按版本数值序、不修改入参）；外链只放行不带凭据的 http(s)；版本展示。
 */

import { describe, it, expect } from "vitest";
import type { NoticeComponent } from "@shared/features/open-source-notices/contract";
import { displayVersion, filterNotices, isSafeExternalUrl, sortNotices } from "./filter";

const c = (over: Partial<NoticeComponent>): NoticeComponent => ({
  id: over.name ?? "x",
  name: "x",
  version: "1.0.0",
  kind: "npm",
  usedBy: "core",
  license: "MIT",
  homepage: null,
  sourceUrl: null,
  modified: false,
  licenseText: null,
  ...over,
});

const list = [
  c({ name: "react", version: "18.3.1", license: "MIT" }),
  c({ name: "FFmpeg", version: "7.0", license: "LGPL-2.1", kind: "binary" }),
  c({ name: "ripgrep", version: "14.1.0", license: "MIT OR Unlicense", kind: "binary" }),
];

describe("filterNotices", () => {
  it("空查询（含纯空白）返回全部，且是新数组", () => {
    expect(filterNotices(list, "")).toEqual(list);
    expect(filterNotices(list, "   ")).toEqual(list);
    expect(filterNotices(list, "")).not.toBe(list);
  });

  it("按名称、版本、许可证匹配，不区分大小写", () => {
    expect(filterNotices(list, "FFMPEG").map((x) => x.name)).toEqual(["FFmpeg"]);
    expect(filterNotices(list, "18.3").map((x) => x.name)).toEqual(["react"]);
    expect(filterNotices(list, "lgpl").map((x) => x.name)).toEqual(["FFmpeg"]);
    expect(filterNotices(list, "mit").map((x) => x.name)).toEqual(["react", "ripgrep"]);
  });

  it("无命中返回空数组", () => {
    expect(filterNotices(list, "nope")).toEqual([]);
  });

  it("版本缺失的组件不会因为 null 抛错", () => {
    expect(filterNotices([c({ name: "a", version: null, license: null })], "a")).toHaveLength(1);
  });
});

describe("sortNotices", () => {
  it("名称不区分大小写排序，不修改入参", () => {
    const before = [...list];
    expect(sortNotices(list).map((x) => x.name)).toEqual(["FFmpeg", "react", "ripgrep"]);
    expect(list).toEqual(before);
  });

  it("同名按版本数值序", () => {
    const out = sortNotices([c({ name: "a", version: "10.0.0" }), c({ name: "a", version: "2.0.0" })]);
    expect(out.map((x) => x.version)).toEqual(["2.0.0", "10.0.0"]);
  });
});

describe("isSafeExternalUrl", () => {
  it("只放行不带凭据的 http(s)", () => {
    expect(isSafeExternalUrl("https://example.com/a.tgz")).toBe(true);
    expect(isSafeExternalUrl("http://example.com")).toBe(true);
    for (const bad of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "ftp://example.com",
      "https://user:pw@example.com",
      "https://user@example.com",
      "not a url",
      "",
      null,
      undefined,
    ]) {
      expect(isSafeExternalUrl(bad as string | null | undefined)).toBe(false);
    }
  });
});

describe("displayVersion", () => {
  it("缺失或空白显示为 -", () => {
    expect(displayVersion("1.2.3")).toBe("1.2.3");
    expect(displayVersion(null)).toBe("-");
    expect(displayVersion("  ")).toBe("-");
  });
});
