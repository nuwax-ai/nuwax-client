import { describe, expect, it } from "vitest";
import { isLocalFileRequestSource, redactLocalFileUrl } from "./contract";

describe("本机授权地址隔离", () => {
  it("删除日志中的授权 host，保留普通URL与资源路径", () => {
    expect(redactLocalFileUrl('load nuwax-local://secret/docs/a.html and https://normal.example/a')).toBe('load nuwax-local://[redacted]/docs/a.html and https://normal.example/a');
  });
  it("识别预览后代与referrer；循环/销毁 frame 不泄漏凭据", () => {
    expect(isLocalFileRequestSource({ frame: { url: "about:blank", parent: { url: "nuwax-local://grant/page.html" } } })).toBe(true);
    expect(isLocalFileRequestSource({ referrer: "nuwax-local://grant/page.html" })).toBe(true);
    const frame: { url: string; parent?: unknown } = { url: "https://business.example" }; frame.parent = frame;
    expect(isLocalFileRequestSource({ frame })).toBe(false);
    expect(isLocalFileRequestSource({ frame: { get url(): string { throw new Error("detached"); } } })).toBe(true);
  });
});
