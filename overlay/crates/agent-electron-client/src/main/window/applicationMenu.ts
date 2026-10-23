import type { MenuItemConstructorOptions, WebContents } from "electron";
import { I18N_KEYS } from "@shared/constants";
import type { CaptureMenuAction } from "@shared/features/capture/contract";
import { CAPTURE_APPLICATION_MENU_VISIBLE } from "@shared/captureMenuPolicy";
import { captureShortcut, recordShortcut, DEFAULT_CAPTURE_SHORTCUT, DEFAULT_RECORD_SHORTCUT } from '@shared/features/capture/preferences';
import type { EditAction } from "../ipc/windowHandlers";

export interface ApplicationMenuActions {
  about: () => void;
  checkUpdate: () => void | Promise<void>;
  settings: () => void;
  newTask: () => void;
  search: () => void;
  modifyWorkspace: () => void;
  openWorkspace: () => void;
  edit: (action: EditAction) => void;
  reload: () => void;
  back: () => void;
  forward: () => void;
  openLogs: () => void;
  capture?: (action: CaptureMenuAction, trigger?: "menu" | "shortcut") => void;
}

type TranslateMenu = (key: string, ...values: string[]) => string;

/** 原生菜单每次构建时读取当前语言，动作由主进程按当前焦点解析。 */
export function buildMacApplicationMenu(
  t: TranslateMenu,
  appName: string,
  actions: ApplicationMenuActions,
  options: { newTaskAvailable?: boolean; captureAvailable?: boolean; captureShortcut?: string; recordShortcut?: string } = {},
): MenuItemConstructorOptions[] {
  const keys = I18N_KEYS.NativeMenu;
  const editItem = (
    key: string,
    accelerator: string,
    action: EditAction,
  ): MenuItemConstructorOptions => ({
    label: t(key),
    accelerator,
    click: () => actions.edit(action),
  });

  return [
    {
      label: appName,
      submenu: [
        { label: t(keys.ABOUT, appName), click: actions.about },
        { label: t(keys.CHECKUPDATE), click: actions.checkUpdate },
        { type: "separator" },
        { label: t(keys.SETTINGS), accelerator: "CmdOrCtrl+,", click: actions.settings },
        { type: "separator" },
        { role: "services", label: t(keys.SERVICES) },
        { role: "hide", label: t(keys.HIDE, appName) },
        { role: "hideOthers", label: t(keys.HIDEOTHERS) },
        { role: "unhide", label: t(keys.UNHIDE) },
        { type: "separator" },
        { role: "quit", label: t(keys.QUIT, appName) },
      ],
    },
    {
      label: t(keys.FILE),
      submenu: [
        ...(options.newTaskAvailable !== false
          ? [{ label: t(keys.NEWTASK), accelerator: "CmdOrCtrl+N", click: actions.newTask }]
          : []),
        { label: t(keys.SEARCH), accelerator: "CmdOrCtrl+K", click: actions.search },
        { type: "separator" },
        { label: t(keys.MODIFYWORKSPACE), click: actions.modifyWorkspace },
        { label: t(keys.OPENWORKSPACE), click: actions.openWorkspace },
      ],
    },
    {
      label: t(keys.EDIT),
      submenu: [
        // webview 编辑必须显式路由，不能改回宿主 role。
        editItem(keys.UNDO, "CmdOrCtrl+Z", "undo"),
        editItem(keys.REDO, "Shift+CmdOrCtrl+Z", "redo"),
        { type: "separator" },
        editItem(keys.CUT, "CmdOrCtrl+X", "cut"),
        editItem(keys.COPY, "CmdOrCtrl+C", "copy"),
        editItem(keys.PASTE, "CmdOrCtrl+V", "paste"),
        editItem(keys.SELECTALL, "CmdOrCtrl+A", "selectAll"),
      ],
    },
    {
      label: t(keys.VIEW),
      submenu: [
        { label: t(keys.RELOAD), accelerator: "CmdOrCtrl+R", click: actions.reload },
        { role: "togglefullscreen", label: t(keys.TOGGLEFULLSCREEN) },
        { type: "separator" },
        { role: "toggleDevTools", label: t(keys.TOGGLEDEVTOOLS) },
      ],
    },
    {
      label: t(keys.WINDOW),
      submenu: [
        { label: t(keys.BACK), accelerator: "CmdOrCtrl+[", click: actions.back },
        { label: t(keys.FORWARD), accelerator: "CmdOrCtrl+]", click: actions.forward },
        { type: "separator" },
        { role: "minimize", label: t(keys.MINIMIZE) },
        { role: "zoom", label: t(keys.ZOOM) },
        { role: "close", label: t(keys.CLOSE) },
        { type: "separator" },
        { role: "front", label: t(keys.FRONT) },
      ],
    },
    ...(options.captureAvailable && actions.capture ? [{
      label: t("Claw.Capture.title"),
      visible: CAPTURE_APPLICATION_MENU_VISIBLE,
      submenu: [
        { label: t("Claw.Capture.screenshot"), accelerator: captureShortcut(options.captureShortcut), click: (_item: unknown, _window: unknown, event: { triggeredByAccelerator?: boolean }) => actions.capture?.("screenshot", event.triggeredByAccelerator ? "shortcut" : "menu") },
        { type: "separator" as const },
        ...(["mp4", "gif"] as const).map((output) => ({
          label: `${t("Claw.Capture.record")} · ${output.toUpperCase()}`,
          ...(output === "mp4" ? { accelerator: recordShortcut(options.recordShortcut) } : {}),
          click: (_item: unknown, _window: unknown, event: { triggeredByAccelerator?: boolean }) => actions.capture?.(output, event.triggeredByAccelerator ? "shortcut" : "menu"),
        })),
      ],
    }] : []),
    {
      label: t(keys.HELP),
      submenu: [{ label: t(keys.OPENLOGS), click: actions.openLogs }],
    },
  ];
}

/** Win/Linux 自绘菜单没有 Electron accelerator；在宿主及其 guest 拦截同一组应用内按键。 */
export function bindCaptureMenuShortcuts(
  target: Pick<WebContents, "on" | "removeListener">,
  dispatch: (action: CaptureMenuAction) => void,
  options: { platform?: NodeJS.Platform; getScreenshotShortcut?: () => string; getRecordShortcut?: () => string; controlRecording?: (action: "pause" | "stop") => boolean } = {},
): () => void {
  const handler = (event: { preventDefault(): void }, input: Electron.Input) => {
    if (input.type !== "keyDown" || input.isAutoRepeat) return;
    const key = input.key.toLowerCase();
    const platform = options.platform ?? process.platform;
    if (platform === "linux" && input.control && input.alt && !input.meta && !input.shift) {
      // Linux 不保证窗口内容保护。录制 UI 隐藏后仍可用应用内按键控制；
      // 空闲时 P 不消费，R 继续原有开始 MP4 行为。
      const control = key === "r" ? "stop" : key === "p" ? "pause" : null;
      if (control && options.controlRecording?.(control)) {
        event.preventDefault();
        return;
      }
    }
    const bindings = [
      [captureShortcut(options.getScreenshotShortcut?.() ?? DEFAULT_CAPTURE_SHORTCUT), 'screenshot'],
      [recordShortcut(options.getRecordShortcut?.() ?? DEFAULT_RECORD_SHORTCUT), 'mp4'],
    ] as const;
    for (const [shortcut, action] of bindings) {
      const tokens = shortcut.split('+');
      const expectedKey = tokens.pop()!.toLowerCase();
      if (key !== expectedKey || !!input.control !== tokens.includes('CmdOrCtrl') || !!input.meta ||
        !!input.alt !== tokens.includes('Alt') || !!input.shift !== tokens.includes('Shift')) continue;
      event.preventDefault();
      dispatch(action);
      return;
    }
  };
  target.on("before-input-event", handler);
  return () => target.removeListener("before-input-event", handler);
}
