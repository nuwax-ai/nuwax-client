import type { MenuItemConstructorOptions } from "electron";
import { I18N_KEYS } from "@shared/constants";
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
}

type TranslateMenu = (key: string, ...values: string[]) => string;

/** 原生菜单每次构建时读取当前语言，动作由主进程按当前焦点解析。 */
export function buildMacApplicationMenu(
  t: TranslateMenu,
  appName: string,
  actions: ApplicationMenuActions,
  options: { newTaskAvailable?: boolean } = {},
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
    {
      label: t(keys.HELP),
      submenu: [{ label: t(keys.OPENLOGS), click: actions.openLogs }],
    },
  ];
}
