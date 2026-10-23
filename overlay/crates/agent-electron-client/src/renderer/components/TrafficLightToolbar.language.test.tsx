import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiRequest, changeLanguage, renderedMenuItems, renderedDropdowns, stateHarness } = vi.hoisted(() => ({
  apiRequest: vi.fn(async () => ({ code: "0000", data: [] })),
  changeLanguage: vi.fn(async () => undefined),
  renderedMenuItems: [] as Array<{ key?: string; onClick?: () => void }>,
  renderedDropdowns: [] as Array<{ label: string; open: boolean; trigger: string[]; enter: number; leave: number; transitionName?: string; onOpenChange: (open: boolean) => void; onClick: () => void }>,
  stateHarness: { enabled: false, index: 0, values: [] as unknown[] },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      if (!stateHarness.enabled) return actual.useState(initial);
      const index = stateHarness.index++;
      if (index >= stateHarness.values.length) stateHarness.values.push(initial);
      return [stateHarness.values[index], (next: unknown) => {
        stateHarness.values[index] = typeof next === "function" ? next(stateHarness.values[index]) : next;
      }];
    },
  };
});

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
    Dropdown: ({ children, menu, trigger, mouseEnterDelay, mouseLeaveDelay, transitionName, open, onOpenChange }: {
      children: React.ReactElement<{ children: string }>;
      menu: { items: Array<{ key?: string; type?: string; label?: React.ReactNode; onClick?: () => void }>; onClick: () => void };
      trigger: string[]; mouseEnterDelay: number; mouseLeaveDelay: number;
      transitionName?: string;
      open: boolean; onOpenChange: (open: boolean) => void;
    }) => {
      renderedDropdowns.push({ label: children.props.children, open, trigger, enter: mouseEnterDelay, leave: mouseLeaveDelay, transitionName, onOpenChange, onClick: menu.onClick });
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
    CameraOutlined: Icon,
    VideoCameraOutlined: Icon,
    FileGifOutlined: Icon,
  };
});
vi.mock("./captionGlyphs", async () => {
  const { default: React } = await import("react");
  const Glyph = () => <span aria-hidden="true" />;
  return { MinGlyph: Glyph, MaxGlyph: Glyph, RestoreGlyph: Glyph, CloseGlyph: Glyph };
});

const paintFrames = new Map<number, FrameRequestCallback>();
let frameId = 0;
const paint = () => {
  const callbacks = [...paintFrames.values()];
  paintFrames.clear();
  callbacks.forEach(callback => callback(0));
};

beforeEach(() => {
  vi.resetModules();
  changeLanguage.mockClear();
  renderedMenuItems.length = 0;
  renderedDropdowns.length = 0;
  stateHarness.enabled = false;
  stateHarness.index = 0;
  stateHarness.values.length = 0;
  paintFrames.clear();
  frameId = 0;
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    paintFrames.set(++frameId, callback);
    return frameId;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => paintFrames.delete(id)));
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

describe("Win/Linux toolbar language", () => {
  it.each(["Win32", "Linux x86_64", "Linux aarch64"])("%s 截图与录屏菜单只显示截图、MP4、GIF 和快捷键，单击仅调用一次控制器", async (platform) => {
    vi.stubGlobal("navigator", { platform });
    const { setCurrentLang } = await import("../services/core/i18n");
    const { default: TrafficLightToolbar } = await import("./TrafficLightToolbar");
    await setCurrentLang("zh-cn");
    const onCapture = vi.fn();
    const markup = renderToStaticMarkup(<TrafficLightToolbar menuCollapsed={false} menuAvailable
      canGoBack={false} canGoForward={false} onToggleMenu={vi.fn()} onBack={vi.fn()}
      onForward={vi.fn()} onReload={vi.fn()} onOpenAbout={vi.fn()} captureMenuVisible captureAvailable onCapture={onCapture} />);
    expect(markup).toContain("截图与录屏");
    expect(markup).toContain("Ctrl+Shift+A");
    expect(markup).toContain("Ctrl+Shift+R");
    expect(markup).toContain("开始录制 · MP4");
    expect(markup).not.toContain("WEBM");
    expect(markup).toContain("开始录制 · GIF");
    const captureItems = renderedMenuItems.filter(item => item.key?.startsWith("capture-"));
    expect(captureItems.map(item => item.key)).toEqual(["capture-screenshot", "capture-mp4", "capture-gif"]);
    for (const item of captureItems) {
      item.onClick?.();
      paint(); paint();
    }
    expect(onCapture.mock.calls).toEqual([["screenshot"], ["mp4"], ["gif"]]);
  });

  it("点击截图先收起无动画菜单并完成绘制，再单次发起采集", async () => {
    const { setCurrentLang } = await import("../services/core/i18n");
    const { default: TrafficLightToolbar } = await import("./TrafficLightToolbar");
    await setCurrentLang("zh-cn");
    stateHarness.enabled = true;
    const onCapture = vi.fn();
    renderToStaticMarkup(<TrafficLightToolbar menuCollapsed={false} menuAvailable
      canGoBack={false} canGoForward={false} onToggleMenu={vi.fn()} onBack={vi.fn()}
      onForward={vi.fn()} onReload={vi.fn()} onOpenAbout={vi.fn()} captureMenuVisible captureAvailable onCapture={onCapture} />);
    renderedDropdowns.find(menu => menu.label === "截图与录屏")!.onOpenChange(true);
    expect(stateHarness.values[0]).toBe("capture");
    expect(renderedDropdowns.every(menu => menu.transitionName === "")).toBe(true);
    renderedMenuItems.find(item => item.key === "capture-screenshot")!.onClick!();
    renderedMenuItems.find(item => item.key === "capture-mp4")!.onClick!();
    expect(stateHarness.values[0]).toBeNull();
    expect(onCapture).not.toHaveBeenCalled();
    paint();
    expect(onCapture).not.toHaveBeenCalled();
    paint();
    expect(onCapture).toHaveBeenCalledTimes(1);
    expect(onCapture).toHaveBeenCalledWith("screenshot");
  });

  it.each([
    ["Win32", false, true], ["Win32", true, false], ["MacIntel", true, true],
    ["Linux x86_64", false, true], ["Linux x86_64", true, false],
  ] as const)("%s availability=%s handler=%s 不暴露不可用的截图菜单", async (platform, available, hasHandler) => {
    vi.stubGlobal("navigator", { platform });
    const { default: TrafficLightToolbar } = await import("./TrafficLightToolbar");
    renderToStaticMarkup(<TrafficLightToolbar menuCollapsed={false} menuAvailable
      canGoBack={false} canGoForward={false} onToggleMenu={vi.fn()} onBack={vi.fn()}
      onForward={vi.fn()} onReload={vi.fn()} onOpenAbout={vi.fn()}
      captureMenuVisible captureAvailable={available} onCapture={hasHandler ? vi.fn() : undefined} />);
    expect(renderedMenuItems.some(item => item.key?.startsWith("capture-"))).toBe(false);
  });

  it.each(["Win32", "Linux x86_64"])("%s 悬停从文件切换到截图菜单时只展开当前菜单，迟到的关闭事件不覆盖新菜单", async (platform) => {
    vi.stubGlobal("navigator", { platform });
    const { setCurrentLang } = await import("../services/core/i18n");
    const { default: TrafficLightToolbar } = await import("./TrafficLightToolbar");
    await setCurrentLang("zh-cn");
    stateHarness.enabled = true;
    const render = () => {
      stateHarness.index = 0;
      renderedDropdowns.length = 0;
      renderToStaticMarkup(<TrafficLightToolbar menuCollapsed={false} menuAvailable
        canGoBack={false} canGoForward={false} onToggleMenu={vi.fn()} onBack={vi.fn()}
        onForward={vi.fn()} onReload={vi.fn()} onOpenAbout={vi.fn()} captureMenuVisible captureAvailable onCapture={vi.fn()} />);
    };
    render();
    const file = renderedDropdowns.find(menu => menu.label === "文件(F)")!;
    const capture = renderedDropdowns.find(menu => menu.label === "截图与录屏")!;
    expect(capture.trigger).toEqual(["hover", "click"]);
    expect(capture.enter).toBe(0);
    file.onOpenChange(true);
    render();
    expect(renderedDropdowns.filter(menu => menu.open).map(menu => menu.label)).toEqual(["文件(F)"]);
    capture.onOpenChange(true);
    file.onOpenChange(false);
    render();
    expect(renderedDropdowns.filter(menu => menu.open).map(menu => menu.label)).toEqual(["截图与录屏"]);
    capture.onClick();
    render();
    expect(renderedDropdowns.some(menu => menu.open)).toBe(false);
  });

  it("Windows 应用菜单悬停立即展开，离开菜单留出进入子菜单的时间", async () => {
    const { default: TrafficLightToolbar } = await import("./TrafficLightToolbar");
    renderToStaticMarkup(<TrafficLightToolbar menuCollapsed={false} menuAvailable
      canGoBack={false} canGoForward={false} onToggleMenu={vi.fn()} onBack={vi.fn()}
      onForward={vi.fn()} onReload={vi.fn()} onOpenAbout={vi.fn()} />);
    expect(renderedDropdowns).toHaveLength(5);
    expect(renderedDropdowns.every(menu => menu.trigger.includes("hover") && menu.enter === 0 && menu.leave > 0)).toBe(true);
  });
  it.each(["Win32", "MacIntel"])("%s 顶部导航不再显示截图相机入口", async (platform) => {
    vi.stubGlobal("navigator", { platform });
    const { default: TrafficLightToolbar } = await import("./TrafficLightToolbar");
    const markup = renderToStaticMarkup(<TrafficLightToolbar
      menuCollapsed={false} menuAvailable canGoBack={false} canGoForward={false}
      onToggleMenu={vi.fn()} onBack={vi.fn()} onForward={vi.fn()} onReload={vi.fn()} onOpenAbout={vi.fn()}
    />);
    expect(markup).not.toContain("截图与录屏");
    expect(markup).not.toContain("相机");
  });

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
      onOpenAbout: vi.fn(),
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
