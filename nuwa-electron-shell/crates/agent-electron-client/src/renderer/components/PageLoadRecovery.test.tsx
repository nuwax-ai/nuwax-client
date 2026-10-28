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
    expect(html).not.toContain("http");
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
