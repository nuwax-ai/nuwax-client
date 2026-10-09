import { describe, expect, it, vi } from "vitest";
import { restoreSpaDocumentRoute } from "./spaDocumentRestore";
import { buildSpaDocumentUrl } from "@shared/utils/spaDocumentRoute";

function page(top = true) {
  const state = { key: "existing", idx: 2 };
  const result = {
    location: { href: buildSpaDocumentUrl(new URL("https://business.example/repo/doc/a?q=%25#title")) },
    history: { state, replaceState: vi.fn(), pushState: vi.fn() },
    top: null as unknown,
  };
  result.top = top ? result : {};
  return result;
}

describe("preload 同步恢复业务 URL", () => {
  it("保留 history state，恢复深链且不增加历史", () => {
    const window = page();
    expect(restoreSpaDocumentRoute(true, window as unknown as Window)).toBe(true);
    expect(window.history.replaceState).toHaveBeenCalledWith(window.history.state, "", "/repo/doc/a?q=%25#title");
    expect(window.history.pushState).not.toHaveBeenCalled();
  });
  it.each([{ allowed: false, top: true }, { allowed: true, top: false }])("外域/社区/子 frame 不恢复：%j", ({ allowed, top }) => {
    const window = page(top);
    expect(restoreSpaDocumentRoute(allowed, window as unknown as Window)).toBe(false);
    expect(window.history.replaceState).not.toHaveBeenCalled();
  });
  it("普通主站 hash 不被接管", () => {
    const window = page(); window.location.href = "https://business.example/home#ordinary";
    expect(restoreSpaDocumentRoute(true, window as unknown as Window)).toBe(false);
    expect(window.history.replaceState).not.toHaveBeenCalled();
  });
});
