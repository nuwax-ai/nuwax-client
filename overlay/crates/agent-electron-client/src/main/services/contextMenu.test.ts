/**
 * 单元测试：页面内右键菜单（禅道 bug 2473：PC 会话页右键无菜单无法复制/另存图片）
 * plans/20260921-bug2473-context-menu-plan.md
 *
 * 根因：Electron 不监听 webContents 的 context-menu 事件就没有任何右键菜单；
 * 本服务对 webview guest 与窗口主 contents 统一挂菜单，编辑命令显式作用于
 * 发射事件的 wc，图片另存复用注入的 saveImage 核心，导航用 navigationHistory
 * entries 真值（gateway origin 下 canGoBack() 恒 false，bug 2432）。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";

let appOnCalls: Array<[string, (...args: unknown[]) => void]> = [];
let allWebContents: Array<Record<string, unknown>> = [];

// 工厂内直接引用的 spy 必须用 vi.hoisted：vi.mock 工厂随 import 提升执行，
// 普通模块级 const 会因 TDZ 抛错（只被闭包延迟引用的 let 不受影响）。
const {
  popupSpy,
  buildFromTemplateMock,
  writeTextSpy,
  showErrorBoxSpy,
  fromWebContentsSpy,
  saveImageCoreMock,
  cursorPoint,
} = vi.hoisted(() => ({
  popupSpy: vi.fn(),
  buildFromTemplateMock: vi.fn(
    (template: unknown) => ({ popup: popupSpy }) as never,
  ),
  writeTextSpy: vi.fn(),
  showErrorBoxSpy: vi.fn(),
  fromWebContentsSpy: vi.fn(() => null),
  saveImageCoreMock: vi.fn(
    async (): Promise<{
      success: boolean;
      canceled?: boolean;
      error?: string;
      path?: string;
    }> => ({ success: true }),
  ),
  cursorPoint: { x: 321, y: 123 },
}));

vi.mock("electron", () => ({
  app: {
    on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
      appOnCalls.push([event, fn]);
    }),
  },
  BrowserWindow: { fromWebContents: fromWebContentsSpy },
  clipboard: { writeText: writeTextSpy },
  dialog: { showErrorBox: showErrorBoxSpy },
  Menu: { buildFromTemplate: buildFromTemplateMock },
  screen: { getCursorScreenPoint: vi.fn(() => cursorPoint) },
  webContents: { getAllWebContents: () => allWebContents },
}));

vi.mock("electron-log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// t → 键名恒等：断言 label 即断言 i18n key（文案本体由 i18nLocales.test.ts 键齐校验兜底）
vi.mock("./i18n", () => ({
  t: (key: string) => key,
}));

import {
  buildContextMenuTemplate,
  installContextMenuService,
} from "./contextMenu";
import type { ContextMenuActions } from "./contextMenu";

interface FakeWC {
  on: ReturnType<typeof vi.fn>;
  fire(event: string, params?: unknown): void;
  [key: string]: unknown;
}

function fakeWC(opts: {
  type?: string;
  url?: string;
  navEntries?: number;
  navActive?: number;
  destroyed?: boolean;
} = {}): FakeWC {
  const listeners = new Map<
    string,
    Array<(e: unknown, p: unknown) => void>
  >();
  const wc: Record<string, unknown> = {
    isDestroyed: vi.fn(() => opts.destroyed ?? false),
    getType: vi.fn(() => opts.type ?? "webview"),
    getURL: vi.fn(() => opts.url ?? "https://agent.nuwax.com/chat"),
    navigationHistory: {
      getAllEntries: vi.fn(() =>
        Array.from({ length: opts.navEntries ?? 1 }, () => ({})),
      ),
      getActiveIndex: vi.fn(() => opts.navActive ?? 0),
      goToIndex: vi.fn(),
    },
    hostWebContents: null,
    on: vi.fn((event: string, fn: (e: unknown, p: unknown) => void) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(fn);
      return wc;
    }),
    copyImageAt: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    cut: vi.fn(),
    copy: vi.fn(),
    paste: vi.fn(),
    delete: vi.fn(),
    selectAll: vi.fn(),
    reload: vi.fn(),
  };
  wc.fire = (event: string, params?: unknown) => {
    for (const fn of listeners.get(event) ?? []) fn({}, params);
  };
  return wc as FakeWC;
}

function fakeActions(): ContextMenuActions {
  return {
    saveImage: vi.fn(),
    copyImageAt: vi.fn(),
    writeClipboard: vi.fn(),
    edit: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
  };
}

function params(patch: Record<string, unknown> = {}): ContextMenuParams {
  return {
    x: 5,
    y: 6,
    mediaType: "none",
    isEditable: false,
    linkURL: "",
    srcURL: "",
    selectionText: "",
    editFlags: {
      canUndo: false,
      canRedo: false,
      canCut: false,
      canCopy: false,
      canPaste: false,
      canDelete: false,
    },
    ...patch,
  } as ContextMenuParams;
}

function labels(template: MenuItemConstructorOptions[]): string[] {
  return template
    .filter((item) => item.type !== "separator")
    .map((item) => String(item.label));
}

function clickItem(
  template: MenuItemConstructorOptions[],
  label: string,
): void {
  const item = template.find(
    (i) => i.type !== "separator" && i.label === label,
  );
  (item as { click?: () => void }).click?.();
}

function lastTemplate(): MenuItemConstructorOptions[] {
  expect(buildFromTemplateMock).toHaveBeenCalled();
  return buildFromTemplateMock.mock.calls.at(-1)![0] as MenuItemConstructorOptions[];
}

function getAppListeners(event: string): Array<(...args: unknown[]) => void> {
  return appOnCalls.filter(([e]) => e === event).map(([, fn]) => fn);
}

beforeEach(() => {
  appOnCalls = [];
  allWebContents = [];
  vi.clearAllMocks();
  buildFromTemplateMock.mockImplementation(
    (template: unknown) => ({ popup: popupSpy }) as never,
  );
});

describe("安装钩子（bug 2473）", () => {
  it("存量 webContents：webview guest 与窗口主 contents 挂 context-menu，devtools/background-page 跳过", () => {
    const guest = fakeWC({ type: "webview" });
    const hostPage = fakeWC({ type: "window" });
    const devtools = fakeWC({
      type: "window",
      url: "devtools://devtools/bundled/inspector.html",
    });
    const background = fakeWC({ type: "background-page" });
    allWebContents = [guest, hostPage, devtools, background];

    installContextMenuService({ saveImage: saveImageCoreMock });

    expect(guest.on).toHaveBeenCalledWith("context-menu", expect.any(Function));
    expect(hostPage.on).toHaveBeenCalledWith(
      "context-menu",
      expect.any(Function),
    );
    expect(devtools.on).not.toHaveBeenCalled();
    expect(background.on).not.toHaveBeenCalled();
  });

  it("注册后新建的 guest（web-contents-created）同样挂监听", () => {
    installContextMenuService({ saveImage: saveImageCoreMock });
    const listeners = getAppListeners("web-contents-created");
    expect(listeners.length).toBeGreaterThan(0);

    const guest = fakeWC({ type: "webview" });
    for (const listener of listeners) listener("event", guest);
    expect(guest.on).toHaveBeenCalledWith("context-menu", expect.any(Function));
  });

  it("已销毁 webContents 静默跳过", () => {
    const destroyed = fakeWC({ type: "webview", destroyed: true });
    allWebContents = [destroyed];
    installContextMenuService({ saveImage: saveImageCoreMock });
    expect(destroyed.on).not.toHaveBeenCalled();
  });
});

describe("弹出与动作（经安装钩子的集成路径）", () => {
  it("会话页选中文本右键 → 复制/全选，点击复制作用于发射事件的 guest", () => {
    const guest = fakeWC();
    allWebContents = [guest];
    installContextMenuService({ saveImage: saveImageCoreMock });

    guest.fire(
      "context-menu",
      params({ selectionText: "被选内容", editFlags: { canCopy: true } }),
    );

    expect(labels(lastTemplate())).toEqual([
      "Claw.ContextMenu.copy",
      "Claw.ContextMenu.selectAll",
    ]);
    // popup 定位用全局光标点（webview guest 的 params.x/y 不是屏幕坐标）
    expect(popupSpy).toHaveBeenCalledWith({
      window: undefined,
      x: cursorPoint.x,
      y: cursorPoint.y,
    });

    clickItem(lastTemplate(), "Claw.ContextMenu.copy");
    expect(guest.copy).toHaveBeenCalled();
  });

  it("图片右键 → 另存为/复制图片/复制图片地址，动作落到 guest 与注入核心", () => {
    const guest = fakeWC();
    allWebContents = [guest];
    installContextMenuService({ saveImage: saveImageCoreMock });

    guest.fire(
      "context-menu",
      params({
        mediaType: "image",
        srcURL: "https://agent.nuwax.com/api/file/a.png",
        linkURL: "https://agent.nuwax.com/some/page",
        selectionText: "选中",
        editFlags: { canCopy: true },
      }),
    );

    expect(labels(lastTemplate())).toEqual([
      "Claw.ContextMenu.saveImageAs",
      "Claw.ContextMenu.copyImage",
      "Claw.ContextMenu.copyImageUrl",
      "Claw.ContextMenu.copyLink",
      "Claw.ContextMenu.copy",
    ]);

    clickItem(lastTemplate(), "Claw.ContextMenu.copyImage");
    expect(guest.copyImageAt).toHaveBeenCalledWith(5, 6);

    clickItem(lastTemplate(), "Claw.ContextMenu.copyImageUrl");
    expect(writeTextSpy).toHaveBeenCalledWith(
      "https://agent.nuwax.com/api/file/a.png",
    );

    clickItem(lastTemplate(), "Claw.ContextMenu.saveImageAs");
    expect(saveImageCoreMock).toHaveBeenCalledWith(
      { url: "https://agent.nuwax.com/api/file/a.png" },
      "https://agent.nuwax.com/chat",
    );
  });

  it("另存失败（非取消）弹系统错误框；用户取消静默", async () => {
    const guest = fakeWC();
    allWebContents = [guest];
    saveImageCoreMock.mockResolvedValueOnce({
      success: false,
      error: "unsupported protocol",
    });
    installContextMenuService({ saveImage: saveImageCoreMock });

    guest.fire("context-menu", params({ mediaType: "image", srcURL: "data:" }));
    clickItem(lastTemplate(), "Claw.ContextMenu.saveImageAs");
    await vi.waitFor(() =>
      expect(showErrorBoxSpy).toHaveBeenCalledWith(
        "Claw.ContextMenu.saveImageAs",
        "unsupported protocol",
      ),
    );

    saveImageCoreMock.mockResolvedValueOnce({
      success: false,
      canceled: true,
    });
    guest.fire("context-menu", params({ mediaType: "image", srcURL: "x" }));
    clickItem(lastTemplate(), "Claw.ContextMenu.saveImageAs");
    await new Promise((r) => setImmediate(r));
    expect(showErrorBoxSpy).toHaveBeenCalledTimes(1);
  });

  it("兜底导航用 navigationHistory entries 真值（bug 2432：canGoBack() 在 gateway origin 恒 false 的防线）", () => {
    const guest = fakeWC({ navEntries: 3, navActive: 1 });
    allWebContents = [guest];
    installContextMenuService({ saveImage: saveImageCoreMock });

    guest.fire("context-menu", params());
    expect(labels(lastTemplate())).toEqual([
      "Claw.ContextMenu.back",
      "Claw.ContextMenu.forward",
      "Claw.ContextMenu.reload",
    ]);
    clickItem(lastTemplate(), "Claw.ContextMenu.back");
    expect(
      (guest.navigationHistory as { goToIndex: ReturnType<typeof vi.fn> })
        .goToIndex,
    ).toHaveBeenCalledWith(0);

    const fresh = fakeWC({ navEntries: 1 });
    allWebContents = [fresh];
    installContextMenuService({ saveImage: saveImageCoreMock });
    fresh.fire("context-menu", params());
    expect(labels(lastTemplate())).toEqual(["Claw.ContextMenu.reload"]);
  });
});

describe("模板构建器（纯函数）", () => {
  const navNone = { canGoBack: false, canGoForward: false };

  it("可编辑满旗：撤销/重做｜剪切/复制/粘贴/删除｜全选", () => {
    const actions = fakeActions();
    const template = buildContextMenuTemplate(
      params({
        isEditable: true,
        selectionText: "ab",
        editFlags: {
          canUndo: true,
          canRedo: true,
          canCut: true,
          canCopy: true,
          canPaste: true,
          canDelete: true,
        },
      }),
      navNone,
      actions,
    );
    expect(labels(template)).toEqual([
      "Claw.ContextMenu.undo",
      "Claw.ContextMenu.redo",
      "Claw.ContextMenu.cut",
      "Claw.ContextMenu.copy",
      "Claw.ContextMenu.paste",
      "Claw.ContextMenu.delete",
      "Claw.ContextMenu.selectAll",
    ]);
    expect(template.filter((i) => i.type === "separator")).toHaveLength(2);
  });

  it("可编辑零旗（无历史无剪贴能力）：仅全选，不出现悬空分隔线", () => {
    const template = buildContextMenuTemplate(
      params({ isEditable: true }),
      navNone,
      fakeActions(),
    );
    expect(labels(template)).toEqual(["Claw.ContextMenu.selectAll"]);
    expect(template.filter((i) => i.type === "separator")).toHaveLength(0);
  });

  it("可编辑有选区但 canPaste false：剪切/复制/删除仍可用", () => {
    const template = buildContextMenuTemplate(
      params({
        isEditable: true,
        selectionText: "ab",
        editFlags: { canCut: true, canCopy: true, canDelete: true },
      }),
      navNone,
      fakeActions(),
    );
    expect(labels(template)).toEqual([
      "Claw.ContextMenu.cut",
      "Claw.ContextMenu.copy",
      "Claw.ContextMenu.delete",
      "Claw.ContextMenu.selectAll",
    ]);
  });

  it("纯链接：仅复制链接；链接+选区补复制", () => {
    const actions = fakeActions();
    expect(
      labels(
        buildContextMenuTemplate(
          params({ linkURL: "https://a.b/c" }),
          navNone,
          actions,
        ),
      ),
    ).toEqual(["Claw.ContextMenu.copyLink"]);

    const template = buildContextMenuTemplate(
      params({
        linkURL: "https://a.b/c",
        selectionText: "x",
        editFlags: { canCopy: true },
      }),
      navNone,
      actions,
    );
    expect(labels(template)).toEqual([
      "Claw.ContextMenu.copyLink",
      "Claw.ContextMenu.copy",
    ]);
    clickItem(template, "Claw.ContextMenu.copyLink");
    expect(actions.writeClipboard).toHaveBeenCalledWith("https://a.b/c");
  });

  it("图片无链接无选区：仅三项图片操作", () => {
    const actions = fakeActions();
    const template = buildContextMenuTemplate(
      params({ mediaType: "image", srcURL: "https://a.b/i.png" }),
      navNone,
      actions,
    );
    expect(labels(template)).toEqual([
      "Claw.ContextMenu.saveImageAs",
      "Claw.ContextMenu.copyImage",
      "Claw.ContextMenu.copyImageUrl",
    ]);
    clickItem(template, "Claw.ContextMenu.copyImage");
    expect(actions.copyImageAt).toHaveBeenCalledWith(5, 6);
    clickItem(template, "Claw.ContextMenu.saveImageAs");
    expect(actions.saveImage).toHaveBeenCalledWith("https://a.b/i.png");
  });

  it("编辑动作路由全集（undo/redo/cut/copy/paste/delete/selectAll）", () => {
    const actions = fakeActions();
    const template = buildContextMenuTemplate(
      params({
        isEditable: true,
        selectionText: "ab",
        editFlags: {
          canUndo: true,
          canRedo: true,
          canCut: true,
          canCopy: true,
          canPaste: true,
          canDelete: true,
        },
      }),
      navNone,
      actions,
    );
    for (const key of [
      "undo",
      "redo",
      "cut",
      "copy",
      "paste",
      "delete",
      "selectAll",
    ]) {
      clickItem(template, `Claw.ContextMenu.${key}`);
      expect(actions.edit).toHaveBeenCalledWith(key);
    }
  });

  it("兜底导航按真值开关：全真/仅后退", () => {
    const actions = fakeActions();
    expect(
      labels(
        buildContextMenuTemplate(
          params(),
          { canGoBack: true, canGoForward: true },
          actions,
        ),
      ),
    ).toEqual([
      "Claw.ContextMenu.back",
      "Claw.ContextMenu.forward",
      "Claw.ContextMenu.reload",
    ]);
    expect(
      labels(
        buildContextMenuTemplate(
          params(),
          { canGoBack: true, canGoForward: false },
          actions,
        ),
      ),
    ).toEqual(["Claw.ContextMenu.back", "Claw.ContextMenu.reload"]);
  });

  it("选区存在但 canCopy=false：不进复制分支，落兜底（reload 恒在）", () => {
    const actions = fakeActions();
    expect(
      labels(
        buildContextMenuTemplate(
          params({ selectionText: "x", editFlags: { canCopy: false } }),
          navNone,
          actions,
        ),
      ),
    ).toEqual(["Claw.ContextMenu.reload"]);
  });
});
