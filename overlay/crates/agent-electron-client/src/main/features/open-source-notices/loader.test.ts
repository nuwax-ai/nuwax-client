/**
 * 单元测试: open-source-notices 加载器
 *
 * 覆盖：候选目录顺序与回落；坏 JSON / 形状不对被跳过且不抛错；坏组件被过滤；
 * 许可证全文：只读 licenses/<安全名>.txt 且属于已知组件（路径穿越、未知 id、超大文件均返回 null）；
 * 结果缓存（只读一次）。
 */

import { describe, it, expect, vi } from "vitest";
import { createNoticesLoader, type NoticesFs } from "./loader";

/** 路径分隔符归一，Windows 下 path.join 产出反斜杠也能命中以 posix 书写的夹具。 */
const norm = (p: string) => p.replace(/\\/g, "/");

function memFs(files: Record<string, string>): NoticesFs & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    existsSync: (p) => norm(p) in files,
    readFileSync: (p) => {
      reads.push(norm(p));
      return files[norm(p)];
    },
    statSync: (p) => ({ size: Buffer.byteLength(files[norm(p)] ?? "") }),
  };
}

const doc = (components: unknown[], schema: unknown = 1) => JSON.stringify({ schema, components });
const comp = (over: Record<string, unknown> = {}) => ({
  id: "ripgrep",
  name: "ripgrep",
  version: "14.1.0",
  kind: "binary",
  usedBy: "core",
  license: "MIT",
  homepage: null,
  sourceUrl: "https://example.com/rg.tgz",
  modified: false,
  licenseText: "licenses/ripgrep.txt",
  ...over,
});

describe("load", () => {
  it("取第一个含声明文件的候选目录，并规整字段", () => {
    const fs = memFs({
      "/b/third-party-notices.json": doc([comp()]),
      "/a2/third-party-notices.json": doc([comp({ id: "other" })]),
    });
    const loader = createNoticesLoader(["/a1", "/b", "/a2"], fs);
    expect(loader.load()).toEqual({
      schema: 1,
      components: [{ ...comp(), notes: null }],
    });
  });

  it("没有任何候选目录含声明文件：返回 null", () => {
    expect(createNoticesLoader(["/x"], memFs({})).load()).toBeNull();
  });

  it("坏 JSON 或形状不对的目录被跳过，回落到后面的目录", () => {
    const fs = memFs({
      "/bad/third-party-notices.json": "{not json",
      "/shape/third-party-notices.json": JSON.stringify({ components: [] }),
      "/ok/third-party-notices.json": doc([comp()]),
    });
    expect(createNoticesLoader(["/bad", "/shape", "/ok"], fs).load()?.components).toHaveLength(1);
  });

  it("形状不对的组件被过滤，其余保留", () => {
    const fs = memFs({
      "/d/third-party-notices.json": doc([comp(), { id: 1 }, comp({ id: "k", kind: "weird" }), "x", null]),
    });
    expect(createNoticesLoader(["/d"], fs).load()?.components.map((c) => c.id)).toEqual(["ripgrep"]);
  });

  it("结果被缓存：重复调用只读一次文件", () => {
    const fs = memFs({ "/d/third-party-notices.json": doc([comp()]) });
    const loader = createNoticesLoader(["/d"], fs);
    loader.load();
    loader.load();
    loader.licenseText("ripgrep");
    expect(fs.reads.filter((p) => p.endsWith("third-party-notices.json"))).toHaveLength(1);
  });
});

describe("licenseText", () => {
  const base = {
    "/d/third-party-notices.json": doc([
      comp(),
      comp({ id: "evil", licenseText: "../../etc/passwd" }),
      comp({ id: "abs", licenseText: "/etc/passwd" }),
      comp({ id: "nested", licenseText: "licenses/a/b.txt" }),
      comp({ id: "big", licenseText: "licenses/big.txt" }),
      comp({ id: "none", licenseText: null }),
    ]),
    "/d/licenses/ripgrep.txt": "MIT License text",
    "/d/licenses/big.txt": "x".repeat(1024 * 1024 + 1),
  };

  it("返回已知组件的许可证全文", () => {
    expect(createNoticesLoader(["/d"], memFs(base)).licenseText("ripgrep")).toBe("MIT License text");
  });

  it("未知 id、无全文、路径穿越、绝对路径、嵌套路径、超大文件都返回 null", () => {
    const loader = createNoticesLoader(["/d"], memFs(base));
    for (const id of ["unknown", "none", "evil", "abs", "nested", "big"]) {
      expect(loader.licenseText(id)).toBeNull();
    }
  });

  it("声明数据不可用时返回 null", () => {
    expect(createNoticesLoader(["/x"], memFs({})).licenseText("ripgrep")).toBeNull();
  });

  it("读取抛错时返回 null 而不是抛出", () => {
    const fs = memFs(base);
    fs.readFileSync = vi.fn((p: string) => {
      if (norm(p).endsWith("ripgrep.txt")) throw new Error("EACCES");
      return base[norm(p) as keyof typeof base];
    });
    expect(createNoticesLoader(["/d"], fs).licenseText("ripgrep")).toBeNull();
  });
});
