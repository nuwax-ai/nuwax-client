/**
 * 页面内右键菜单服务（禅道 bug 2473：PC 会话页右键无菜单，无法复制/另存图片）。
 *
 * 根因：Electron 只有应用监听 webContents 的 context-menu 事件并 menu.popup()
 * 才会有右键菜单（Chromium 原生菜单默认禁用）；壳此前无任何监听，页面内右键
 * 无任何反应。键盘 ⌘C/Ctrl+C 走标准应用菜单编辑路由不受影响，缺的是右键这一路。
 *
 * 形态：
 * - 挂点：app.on("web-contents-created") + 存量 webContents 补挂（同
 *   nuwaxBridgeHandlers 的 nav 真值/顶栏收起钩子先例）；只挂 webview guest
 *   （getType()="webview"）与窗口主 contents（getType()="window"，覆盖宿主页、
 *   webviewPolicy 弹窗窗）；devtools:// 内容跳过。
 * - 编辑命令显式路由到发射事件的 wc（裸 role 在 webview 场景不可用——enable
 *   校验与命令分发落在宿主页，同 windowHandlers.resolveEditTargetWebContents 注释
 *   的结论）。
 * - 图片「另存为…」复用 nuwaxBridgeHandlers 的 native:saveImage 核心（相对地址
 *   归一 / Bearer 代注 / 重定向逐跳重试 / 系统保存对话框），由注册方注入。
 * - 「复制图片」用 wc.copyImageAt(x, y)：坐标即 context-menu params 的页面坐标。
 * - popup 定位取 screen.getCursorScreenPoint()：右键弹出即鼠标位置，规避 guest
 *   页面坐标 → 屏幕坐标的换算（webview guest 的 params.x/y 不是屏幕坐标）。
 * - 后退/前进用 navigationHistory entries 真值判断 + goToIndex 执行——gateway
 *   origin 下 canGoBack()/goBack() 恒 false（bug 2432 实证），同 readNavState。
 *
 * 前端自绘右键（antd Dropdown trigger=contextMenu，如会话列表/文件树）会
 * preventDefault DOM contextmenu 事件，Chromium 不再请求菜单、主进程
 * context-menu 不触发，天然无双重菜单。
 */
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  screen,
  webContents,
} from "electron";
import type {
  ContextMenuParams,
  MenuItemConstructorOptions,
  WebContents,
} from "electron";
import log from "electron-log";
import { t } from "./i18n";

/** native:saveImage 核心的结果形状（见 nuwaxBridgeHandlers.performSaveImage）。 */
export interface ContextMenuImageSaveResult {
  success: boolean;
  canceled?: boolean;
  error?: string;
  path?: string;
}

/** 由注册方注入的依赖：图片另存核心（含鉴权与保存对话框）。 */
export interface ContextMenuDeps {
  saveImage: (
    opts: { url: string; filename?: string },
    frameUrl: string | undefined,
  ) => Promise<ContextMenuImageSaveResult>;
}

/** 模板构建器用到的动作集（安装侧映射到发射事件的 wc；测试可全量替身）。 */
export interface ContextMenuActions {
  saveImage(url: string): void;
  copyImageAt(x: number, y: number): void;
  writeClipboard(text: string): void;
  edit(action: ContextMenuEditAction): void;
  goBack(): void;
  goForward(): void;
  reload(): void;
}

export type ContextMenuEditAction =
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "delete"
  | "selectAll";

/** 编辑命令显式作用于目标 wc——webview 场景裸 role 不可用（见文件头）。 */
const EDIT_COMMANDS: Record<
  ContextMenuEditAction,
  (wc: WebContents) => void
> = {
  undo: (wc) => wc.undo(),
  redo: (wc) => wc.redo(),
  cut: (wc) => wc.cut(),
  copy: (wc) => wc.copy(),
  paste: (wc) => wc.paste(),
  delete: (wc) => wc.delete(),
  selectAll: (wc) => wc.selectAll(),
};

/**
 * 按右键上下文构建菜单模板（纯函数，便于单测）：
 * - 图片：另存为… / 复制图片 / 复制图片地址；图片在链接内补「复制链接」，
 *   页面有选区补「复制」；
 * - 链接：复制链接（+ 选区时补「复制」）；
 * - 可编辑：撤销/重做（canUndo/canRedo）｜剪切/复制/粘贴/删除（editFlags 守卫）｜
 *   全选；
 * - 纯选区：复制 / 全选；
 * - 兜底：后退/前进（nav 真值）+ 重新加载（永远有，右键不至于无响应）。
 */
export function buildContextMenuTemplate(
  params: ContextMenuParams,
  nav: { canGoBack: boolean; canGoForward: boolean },
  actions: ContextMenuActions,
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];
  const flags = params.editFlags;
  const hasSelection =
    Boolean(params.selectionText) && flags?.canCopy !== false;

  // —— 图片上下文（含聊天消息图片；前端 OptimizedImage 的右键直出另存已撤，
  //    统一走本菜单）——
  if (params.mediaType === "image" && params.srcURL) {
    items.push(
      {
        label: t("Claw.ContextMenu.saveImageAs"),
        click: () => actions.saveImage(params.srcURL),
      },
      {
        label: t("Claw.ContextMenu.copyImage"),
        click: () => actions.copyImageAt(params.x, params.y),
      },
      {
        label: t("Claw.ContextMenu.copyImageUrl"),
        click: () => actions.writeClipboard(params.srcURL),
      },
    );
    if (params.linkURL) {
      items.push(
        { type: "separator" },
        {
          label: t("Claw.ContextMenu.copyLink"),
          click: () => actions.writeClipboard(params.linkURL),
        },
      );
    }
    if (hasSelection) {
      items.push(
        { type: "separator" },
        {
          label: t("Claw.ContextMenu.copy"),
          click: () => actions.edit("copy"),
        },
      );
    }
    return items;
  }

  // —— 链接上下文 ——
  if (params.linkURL) {
    items.push({
      label: t("Claw.ContextMenu.copyLink"),
      click: () => actions.writeClipboard(params.linkURL),
    });
    if (hasSelection) {
      items.push(
        { type: "separator" },
        {
          label: t("Claw.ContextMenu.copy"),
          click: () => actions.edit("copy"),
        },
      );
    }
    return items;
  }

  // —— 可编辑上下文（输入框 / contenteditable）——
  if (params.isEditable) {
    const history: MenuItemConstructorOptions[] = [];
    if (flags?.canUndo) {
      history.push({
        label: t("Claw.ContextMenu.undo"),
        click: () => actions.edit("undo"),
      });
    }
    if (flags?.canRedo) {
      history.push({
        label: t("Claw.ContextMenu.redo"),
        click: () => actions.edit("redo"),
      });
    }
    const clipboardOps: MenuItemConstructorOptions[] = [];
    if (flags?.canCut && params.selectionText) {
      clipboardOps.push({
        label: t("Claw.ContextMenu.cut"),
        click: () => actions.edit("cut"),
      });
    }
    if (flags?.canCopy && params.selectionText) {
      clipboardOps.push({
        label: t("Claw.ContextMenu.copy"),
        click: () => actions.edit("copy"),
      });
    }
    if (flags?.canPaste) {
      clipboardOps.push({
        label: t("Claw.ContextMenu.paste"),
        click: () => actions.edit("paste"),
      });
    }
    if (flags?.canDelete && params.selectionText) {
      clipboardOps.push({
        label: t("Claw.ContextMenu.delete"),
        click: () => actions.edit("delete"),
      });
    }
    const selectAll: MenuItemConstructorOptions = {
      label: t("Claw.ContextMenu.selectAll"),
      click: () => actions.edit("selectAll"),
    };
    if (history.length) items.push(...history, { type: "separator" });
    if (clipboardOps.length) items.push(...clipboardOps, { type: "separator" });
    items.push(selectAll);
    return items;
  }

  // —— 纯选区上下文（bug 主诉：会话页选中内容右键复制）——
  if (hasSelection) {
    return [
      {
        label: t("Claw.ContextMenu.copy"),
        click: () => actions.edit("copy"),
      },
      {
        label: t("Claw.ContextMenu.selectAll"),
        click: () => actions.edit("selectAll"),
      },
    ];
  }

  // —— 兜底：导航 + 重新加载（恒非空，页面空白处右键也有响应）——
  if (nav.canGoBack) {
    items.push({
      label: t("Claw.ContextMenu.back"),
      click: () => actions.goBack(),
    });
  }
  if (nav.canGoForward) {
    items.push({
      label: t("Claw.ContextMenu.forward"),
      click: () => actions.goForward(),
    });
  }
  items.push({
    label: t("Claw.ContextMenu.reload"),
    click: () => actions.reload(),
  });
  return items;
}

/** navigationHistory entries 真值（gateway origin 下 canGoBack() 恒 false，bug 2432）。 */
function readNavTruth(wc: WebContents): {
  canGoBack: boolean;
  canGoForward: boolean;
} {
  try {
    const h = wc.navigationHistory;
    const entries = h?.getAllEntries?.() ?? [];
    const active = h?.getActiveIndex?.() ?? 0;
    return {
      canGoBack: entries.length > 1 && active > 0,
      canGoForward: active < entries.length - 1,
    };
  } catch {
    return { canGoBack: false, canGoForward: false };
  }
}

function goNavIndex(wc: WebContents, dir: "back" | "forward"): void {
  try {
    const h = wc.navigationHistory;
    const entries = h?.getAllEntries?.() ?? [];
    const active = h?.getActiveIndex?.() ?? 0;
    const target = dir === "back" ? active - 1 : active + 1;
    if (target >= 0 && target < entries.length) {
      h.goToIndex(target);
    }
  } catch (error) {
    log.warn("[ContextMenu] nav go failed:", error);
  }
}

/** 右键归属窗口：窗口主 contents 直查；webview guest 经 hostWebContents 归属宿主窗。 */
function resolveOwnerWindow(wc: WebContents): BrowserWindow | null {
  return (
    BrowserWindow.fromWebContents(wc) ??
    (wc.hostWebContents
      ? BrowserWindow.fromWebContents(wc.hostWebContents)
      : null)
  );
}

function makeActions(
  wc: WebContents,
  deps: ContextMenuDeps,
): ContextMenuActions {
  return {
    saveImage: (url) => {
      void deps
        .saveImage({ url }, safeGetURL(wc))
        .then((result) => {
          // 取消静默；真实失败（如非 http 协议/会话切换/网络错误）用系统错误框
          // 告知——IPC 路径由前端 message.error 兜底，菜单路径没有页面 UI 可用。
          if (!result.success && !result.canceled && result.error) {
            dialog.showErrorBox(t("Claw.ContextMenu.saveImageAs"), result.error);
          }
        })
        .catch((error) => log.error("[ContextMenu] saveImage failed:", error));
    },
    copyImageAt: (x, y) => wc.copyImageAt(x, y),
    writeClipboard: (text) => clipboard.writeText(text),
    edit: (action) => EDIT_COMMANDS[action](wc),
    goBack: () => goNavIndex(wc, "back"),
    goForward: () => goNavIndex(wc, "forward"),
    reload: () => wc.reload(),
  };
}

function safeGetURL(wc: WebContents): string | undefined {
  try {
    return wc.getURL() || undefined;
  } catch {
    return undefined;
  }
}

function showContextMenu(
  wc: WebContents,
  params: ContextMenuParams,
  deps: ContextMenuDeps,
): void {
  const template = buildContextMenuTemplate(params, readNavTruth(wc), makeActions(wc, deps));
  if (!template.length) return;
  const menu = Menu.buildFromTemplate(template);
  const point = screen.getCursorScreenPoint();
  menu.popup({
    window: resolveOwnerWindow(wc) ?? undefined,
    x: point.x,
    y: point.y,
  });
}

/**
 * 安装右键菜单服务。注册入口：nuwaxBridgeHandlers boot 区（registerAllHandlers
 * 在 app ready 后执行一次；同既有 web-contents-created 钩子，不做幂等守卫）。
 */
export function installContextMenuService(deps: ContextMenuDeps): void {
  const hook = (wc: WebContents) => {
    if (wc.isDestroyed()) return;
    const type = wc.getType();
    if (type !== "webview" && type !== "window") return;
    const url = safeGetURL(wc);
    if (url?.startsWith("devtools://")) return;
    wc.on("context-menu", (_event, params) => {
      try {
        showContextMenu(wc, params, deps);
      } catch (error) {
        log.error("[ContextMenu] show failed:", error);
      }
    });
  };
  app.on("web-contents-created", (_e, wc) => hook(wc));
  for (const wc of webContents.getAllWebContents()) hook(wc);
}
