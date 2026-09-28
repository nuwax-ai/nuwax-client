import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiRequest, changeLanguage, renderedMenuItems } = vi.hoisted(() => ({
  apiRequest: vi.fn(async () => ({ code: "0000", data: [] })),
  changeLanguage: vi.fn(async () => undefined),
  renderedMenuItems: [] as Array<{ key?: string; onClick?: () => void }>,
}));

vi.mock("../services/core/api", () => ({ apiRequest }));
vi.mock("../services/i18n", () => ({ default: { changeLanguage } }));
vi.mock("@shared/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@shared/constants")>()),
  APP_NAME_IDENTIFIER: "nuwax",
}));

// Keep the actual toolbar render and menu labels, without antd's DOM/portal requirements.
vi.mock("antd", async () => {
  const { default: React } = await import("react");
  return {
    Button: ({ children, disabled }: { children: React.ReactNode; disabled?: boolean }) => (
      <button disabled={disabled}>{children}</button>
    ),
    Tooltip: ({ title, children }: { title: string; children: React.ReactNode }) => (
      <span data-tooltip={title}>{children}</span>
    ),
    Dropdown: ({ children, menu }: {
      children: React.ReactNode;
      menu: { items: Array<{ key?: string; type?: string; label?: React.ReactNode; onClick?: () => void }> };
    }) => {
      renderedMenuItems.push(...menu.items);
      return (
        <div>
          {children}
          <ul>
            {menu.items.filter((item) => item.type !== "divider").map((item) => (
              <li key={item.key} data-menu-key={item.key}>{item.label}</li>
            ))}
          </ul>
        </div>
      );
    },
  };
});
vi.mock("@ant-design/icons", async () => {
  const { default: React } = await import("react");
  const Icon = () => <span aria-hidden="true" />;
  return {
    MenuFoldOutlined: Icon,
    MenuUnfoldOutlined: Icon,
    SettingOutlined: Icon,
    LeftOutlined: Icon,
    RightOutlined: Icon,
  };
});
vi.mock("./captionGlyphs", async () => {
  const { default: React } = await import("react");
  const Glyph = () => <span aria-hidden="true" />;
  return { MinGlyph: Glyph, MaxGlyph: Glyph, RestoreGlyph: Glyph, CloseGlyph: Glyph };
});

beforeEach(() => {
  vi.resetModules();
  changeLanguage.mockClear();
  renderedMenuItems.length = 0;
  vi.stubGlobal("navigator", { platform: "Win32" });
  vi.stubGlobal("window", {
    electronAPI: {
      settings: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) },
      on: vi.fn(),
      off: vi.fn(),
      window: {
        isMaximized: vi.fn(async () => false),
        minimize: vi.fn(),
        maximize: vi.fn(),
        close: vi.fn(),
      },
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

const simplified = {
  headings: ["关于(A)", "文件(F)", "编辑(E)", "窗口(W)", "帮助(H)"],
  items: {
    about: "关于与检查更新", settings: "设置", newTask: "新建任务Ctrl+N",
    search: "搜索Ctrl+K", modifyWorkspace: "更改工作空间目录…", openWorkspace: "打开工作空间目录",
    undo: "撤销Ctrl+Z", redo: "重做Shift+Ctrl+Z", cut: "剪切Ctrl+X", copy: "复制Ctrl+C",
    paste: "粘贴Ctrl+V", selectAll: "全选Ctrl+A", back: "后退", forward: "前进",
    reload: "重新加载Ctrl+R", minimize: "最小化", maximize: "最大化", close: "关闭", logs: "打开日志目录",
  },
  tooltips: ["收起侧栏", "设置", "后退", "前进"],
  expand: "展开侧栏",
  controls: ["最小化", "最大化", "关闭"],
};
const english = {
  headings: ["About(A)", "File(F)", "Edit(E)", "Window(W)", "Help(H)"],
  items: {
    about: "About and Check for Updates", settings: "Settings", newTask: "New TaskCtrl+N",
    search: "SearchCtrl+K", modifyWorkspace: "Change Workspace Directory…", openWorkspace: "Open Workspace Directory",
    undo: "UndoCtrl+Z", redo: "RedoShift+Ctrl+Z", cut: "CutCtrl+X", copy: "CopyCtrl+C",
    paste: "PasteCtrl+V", selectAll: "Select AllCtrl+A", back: "Back", forward: "Forward",
    reload: "ReloadCtrl+R", minimize: "Minimize", maximize: "Maximize", close: "Close", logs: "Open Logs Directory",
  },
  tooltips: ["Collapse Sidebar", "Settings", "Back", "Forward"],
  expand: "Expand Sidebar",
  controls: ["Minimize", "Maximize", "Close"],
};
const traditional = {
  headings: ["關於(A)", "檔案(F)", "編輯(E)", "視窗(W)", "說明(H)"],
  items: {
    about: "關於及檢查更新", settings: "設定", newTask: "新增任務Ctrl+N",
    search: "搜尋Ctrl+K", modifyWorkspace: "變更工作區目錄…", openWorkspace: "開啟工作區目錄",
    undo: "撤銷Ctrl+Z", redo: "重做Shift+Ctrl+Z", cut: "剪下Ctrl+X", copy: "複製Ctrl+C",
    paste: "貼上Ctrl+V", selectAll: "全選Ctrl+A", back: "後退", forward: "前進",
    reload: "重新載入Ctrl+R", minimize: "最小化", maximize: "最大化", close: "關閉", logs: "開啟日誌目錄",
  },
  tooltips: ["收起側欄", "設定", "後退", "前進"],
  expand: "展開側欄",
  controls: ["最小化", "最大化", "關閉"],
};

const getAttributeValues = (markup: string, attribute: string): string[] =>
  [...markup.matchAll(new RegExp(`${attribute}="([^"]*)"`, "g"))].map((match) => match[1]);

describe("Windows toolbar language", () => {
  it.each(["Win32", "Linux x86_64"])("%s 按可用状态显隐新建任务，其他菜单与动作不变", async (platform) => {
    vi.stubGlobal("navigator", { platform });
    const { setCurrentLang } = await import("../services/core/i18n");
    const { default: TrafficLightToolbar } = await import("./TrafficLightToolbar");
    await setCurrentLang("zh-cn");
    const props = {
      menuCollapsed: false,
      menuAvailable: true,
      canGoBack: true,
      canGoForward: true,
      onToggleMenu: vi.fn(),
      onBack: vi.fn(),
      onForward: vi.fn(),
      onReload: vi.fn(),
      onNewTask: vi.fn(),
      onOpenSearch: vi.fn(),
      onModifyWorkspace: vi.fn(),
      onOpenWorkspace: vi.fn(),
    };
    const visible = renderToStaticMarkup(<TrafficLightToolbar {...props} newTaskAvailable />);
    expect(renderedMenuItems.find((item) => item.key === "newTask")?.onClick).toBe(props.onNewTask);
    renderedMenuItems.length = 0;
    const hidden = renderToStaticMarkup(<TrafficLightToolbar {...props} newTaskAvailable={false} />);
    expect(hidden).toBe(visible.replace(/<li data-menu-key="newTask">.*?<\/li>/, ""));
    expect(hidden).not.toContain("Ctrl+N");
    expect(renderedMenuItems.some((item) => item.key === "newTask")).toBe(false);
    for (const key of ["search", "modifyWorkspace", "openWorkspace"]) {
      renderedMenuItems.find((item) => item.key === key)?.onClick?.();
    }
    expect(props.onNewTask).not.toHaveBeenCalled();
    expect(props.onOpenSearch).toHaveBeenCalledOnce();
    expect(props.onModifyWorkspace).toHaveBeenCalledOnce();
    expect(props.onOpenWorkspace).toHaveBeenCalledOnce();
  });

  it("renders headings, dropdown items and tooltips in each selected language and switches back", async () => {
    const { setCurrentLang } = await import("../services/core/i18n");
    const { default: TrafficLightToolbar } = await import("./TrafficLightToolbar");
    const props = {
      menuCollapsed: false,
      menuAvailable: true,
      newTaskAvailable: true,
      canGoBack: true,
      canGoForward: true,
      onToggleMenu: vi.fn(),
      onBack: vi.fn(),
      onForward: vi.fn(),
      onReload: vi.fn(),
      onOpenSettings: vi.fn(),
      onOpenAbout: vi.fn(),
    };

    for (const [lang, expected] of [
      ["zh-cn", simplified], ["en-us", english],
      ["zh-tw", traditional], ["zh-hk", traditional], ["zh-cn", simplified],
    ] as const) {
      await setCurrentLang(lang);
      const markup = renderToStaticMarkup(<TrafficLightToolbar {...props} />);
      const headings = [...markup.matchAll(/class="topbar-menu-btn">([^<]*)<\/button>/g)]
        .map((match) => match[1]);
      const items = Object.fromEntries(
        [...markup.matchAll(/<li data-menu-key="([^"]*)">(.*?)<\/li>/g)]
          .map((match) => [match[1], match[2].replace(/<[^>]*>/g, "")]),
      );

      expect(headings, lang).toEqual(expected.headings);
      expect(items, lang).toEqual(expected.items);
      expect(getAttributeValues(markup, "data-tooltip"), lang).toEqual(expected.tooltips);
      expect(getAttributeValues(markup, "aria-label"), lang).toEqual(expected.controls);
      expect(getAttributeValues(markup, "title"), lang).toEqual(expected.controls);
      const collapsed = renderToStaticMarkup(<TrafficLightToolbar {...props} menuCollapsed />);
      expect(getAttributeValues(collapsed, "data-tooltip")[0], lang).toBe(expected.expand);
      expect(changeLanguage).toHaveBeenLastCalledWith(lang);
    }
  });
});
