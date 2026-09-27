import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getLocale: () => "en-US",
  },
}));
vi.mock("electron-log", () => ({
  default: { info: vi.fn(), warn: vi.fn() },
}));

import { initI18n, onMainLangChanged, setMainLang, t } from "../services/i18n";
import { buildMacApplicationMenu, type ApplicationMenuActions } from "./applicationMenu";

function makeActions(): ApplicationMenuActions {
  return {
    about: vi.fn(), checkUpdate: vi.fn(), settings: vi.fn(),
    newTask: vi.fn(), search: vi.fn(), modifyWorkspace: vi.fn(),
    openWorkspace: vi.fn(), edit: vi.fn(), reload: vi.fn(),
    back: vi.fn(), forward: vi.fn(), openLogs: vi.fn(),
  };
}

function children(item: MenuItemConstructorOptions): MenuItemConstructorOptions[] {
  return item.submenu as MenuItemConstructorOptions[];
}

function labels(template: MenuItemConstructorOptions[]): string[] {
  return template.flatMap((item) => [
    ...(item.label ? [item.label] : []),
    ...children(item).flatMap((child) => child.label ? [child.label] : []),
  ]);
}

describe("macOS 原生菜单语言与动作", () => {
  const unsubscribers: Array<() => void> = [];

  beforeEach(() => {
    initI18n();
    setMainLang("zh-cn");
  });
  afterEach(() => {
    unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
  });

  it.each([
    ["en-US", ["Nuwax", "File", "Edit", "View", "Window", "Help"], "About Nuwax", "Quit Nuwax"],
    ["zh-CN", ["Nuwax", "文件", "编辑", "视图", "窗口", "帮助"], "关于 Nuwax", "退出 Nuwax"],
    ["zh-TW", ["Nuwax", "檔案", "編輯", "顯示方式", "視窗", "輔助說明"], "關於 Nuwax", "結束 Nuwax"],
    ["zh-HK", ["Nuwax", "檔案", "編輯", "檢視", "視窗", "說明"], "關於 Nuwax", "結束 Nuwax"],
  ])("%s 使用原生菜单文案", (lang, titles, about, quit) => {
    setMainLang(lang as string);
    const template = buildMacApplicationMenu(t, "Nuwax", makeActions());
    expect(template.map((item) => item.label)).toEqual(titles);
    expect(children(template[0])[0].label).toBe(about);
    expect(children(template[0]).at(-1)?.label).toBe(quit);
    expect(labels(template)).toHaveLength(34);
    expect(labels(template).some((label) => /Claw\.|\([AFEWH]\)/.test(label))).toBe(false);
  });

  it("英文菜单所有入口都有英文文案", () => {
    setMainLang("en-US");
    expect(labels(buildMacApplicationMenu(t, "Nuwax", makeActions()))).toEqual([
      "Nuwax", "About Nuwax", "Check for Updates…", "Settings…", "Services",
      "Hide Nuwax", "Hide Others", "Show All", "Quit Nuwax", "File", "New Task",
      "Search", "Change Workspace Directory…", "Open Workspace Directory", "Edit",
      "Undo", "Redo", "Cut", "Copy", "Paste", "Select All", "View", "Reload Page",
      "Enter Full Screen", "Toggle Developer Tools", "Window", "Back", "Forward",
      "Minimize", "Zoom", "Close Window", "Bring All to Front", "Help", "Open Logs Directory",
    ]);
  });

  it("语言切换即时重建菜单，同语种同步不重建、不调用动作", () => {
    const actions = makeActions();
    const rendered: MenuItemConstructorOptions[][] = [];
    const renderMenu = () => rendered.push(buildMacApplicationMenu(t, "Nuwax", actions));
    renderMenu();
    unsubscribers.push(onMainLangChanged(renderMenu));
    for (const lang of ["en-US", "en-us", "zh-TW", "zh-HK", "zh-CN"]) {
      setMainLang(lang);
    }
    expect(rendered.map((menu) => menu[1].label)).toEqual(["文件", "File", "檔案", "檔案", "文件"]);
    expect(rendered.map((menu) => menu[5].label)).toEqual(["帮助", "Help", "輔助說明", "說明", "帮助"]);
    Object.values(actions).forEach((action) => expect(action).not.toHaveBeenCalled());
  });

  it("保留窗口 roles、编辑路由和各菜单动作", () => {
    const actions = makeActions();
    const template = buildMacApplicationMenu(t, "Nuwax", actions);
    const click = (item: MenuItemConstructorOptions) => item.click?.({} as never, {} as never, {} as never);
    const appMenu = children(template[0]);
    const file = children(template[1]);
    const edit = children(template[2]);
    const view = children(template[3]);
    const window = children(template[4]);
    expect(appMenu.filter((item) => item.role).map((item) => item.role))
      .toEqual(["services", "hide", "hideOthers", "unhide", "quit"]);
    expect(view.filter((item) => item.role).map((item) => item.role))
      .toEqual(["togglefullscreen", "toggleDevTools"]);
    expect(window.filter((item) => item.role).map((item) => item.role))
      .toEqual(["minimize", "zoom", "close", "front"]);
    expect(edit.filter((item) => item.type !== "separator").map((item) => item.accelerator))
      .toEqual(["CmdOrCtrl+Z", "Shift+CmdOrCtrl+Z", "CmdOrCtrl+X", "CmdOrCtrl+C", "CmdOrCtrl+V", "CmdOrCtrl+A"]);
    expect(edit.some((item) => item.role)).toBe(false);
    edit.filter((item) => item.type !== "separator").forEach(click);
    expect(vi.mocked(actions.edit).mock.calls.map(([action]) => action))
      .toEqual(["undo", "redo", "cut", "copy", "paste", "selectAll"]);
    expect([appMenu[3], file[0], file[1], view[0], window[0], window[1]].map((item) => item.accelerator))
      .toEqual(["CmdOrCtrl+,", "CmdOrCtrl+N", "CmdOrCtrl+K", "CmdOrCtrl+R", "CmdOrCtrl+[", "CmdOrCtrl+]"]);
    [appMenu[0], appMenu[1], appMenu[3], file[0], file[1], file[3], file[4], view[0], window[0], window[1], children(template[5])[0]].forEach(click);
    Object.entries(actions).filter(([name]) => name !== "edit")
      .forEach(([, action]) => expect(action).toHaveBeenCalledOnce());
  });
});
