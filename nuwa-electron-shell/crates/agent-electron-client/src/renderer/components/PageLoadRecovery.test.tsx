import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PageLoadRecovery } from "./PageLoadRecovery";
describe("local recovery UI", () => {
  it("makes reload/settings keyboard-native and keeps diagnostics folded and whitelisted", () => {
    const html = renderToStaticMarkup(
      <PageLoadRecovery
        mode="failed"
        stage="load"
        lang="zh-CN"
        code={-105}
        onReload={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("重新加载");
    expect(html).toContain("设置");
    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
    expect(html).toContain("-105");
    expect(html).toContain("域名无法解析");
    expect(html).not.toContain("http");
  });
  it("explains common network errors without exposing arbitrary URLs", () => {
    for (const [code, expected] of [[-106, "网络不可用"], [-202, "无法验证服务器证书"], [-118, "连接超时"]] as const) {
      expect(renderToStaticMarkup(<PageLoadRecovery mode="failed" code={code} lang="zh-CN" />)).toContain(expected);
    }
  });
  it("exposes busy state without disabling settings and provides local traditional/English copy", () => {
    const html = renderToStaticMarkup(
      <PageLoadRecovery
        mode="reloading"
        lang="zh-TW"
        onReload={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );
    expect(html).toContain("正在重新載入");
    expect(html.match(/disabled/g)).toHaveLength(1);
    expect(
      renderToStaticMarkup(<PageLoadRecovery mode="waiting" lang="en-US" />),
    ).toContain("You can keep waiting or reload the page.");
  });
});
