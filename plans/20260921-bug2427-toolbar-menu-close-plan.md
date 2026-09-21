# bug2427 Win/Linux 工具栏菜单不自动收起——修复计划

- 日期：2026-09-21 · 禅道：zt.nuwax.com bugID=2427（激活，严重程度 1，指派罗东，赵立坤 2026-09-18 报）
- 状态：修复已实施（全 overlay，外层仓提交）；门禁 test:commercial 1498 passed（含新增 6 用例）/ tsc 205≈基线且本批文件零错误；mac 无菜单栏无法目检，待 Windows 真机验收（随下次提测构建）
- 症状（bug 截图 fileID=3213，红字批注）：点工具栏菜单（如「编辑(E)」）弹出下拉后，再点页面内左侧导航（QA 称「系统菜单」），工具栏菜单不收起。

## 根因（代码级）

- Win/Linux 顶行自绘菜单栏 = 5 个 antd `Dropdown trigger={["click"]}`（overlay `renderer/components/TrafficLightToolbar.tsx` 的 `TopMenu`），浮于 `NuwaxHostWebview` 之上。
- antd/rc-trigger 的「点外部收起」监听的是**宿主 renderer document** 的 mousedown；而页面内容在 **webview guest 独立文档**里，guest 内点击不冒泡到宿主 document → 收起逻辑永不触发，菜单挂住。QA 所点左侧导航恰是 guest 内容，必现。
- 同理宿主窗口失焦（点窗口外/任务栏）antd 也不收起；顶行中部拖拽 spacer（app-region:drag）区域点击无 DOM 事件，属同类边界（本次一并由窗口/焦点信号覆盖不了，见「遗留」）。
- mac 不受影响：`menuBar` 仅 `!isMac` 渲染，mac 走系统原生菜单。

## 修复方案（全 overlay，走焦点真值信号）

主进程广播「收起信号」→ 工具栏菜单改受控 open，收到即关：

| # | 文件（均在 overlay crates/agent-electron-client/src） | 改动 |
| --- | --- | --- |
| 1 | main/ipc/nuwaxBridgeHandlers.ts | 复用 webview-nav 通道的 guest 识别法（`webContents.getAllWebContents().find(getType()==="webview")` + `app.on("web-contents-created")`），guest `focus` 即向全部窗口 send `nuwax:dismiss-topbar-menus`（点进页面=guest 得焦，点击菜单的前提是宿主得焦，焦点翻转不变式成立）；`app.on("browser-window-blur")` 向失焦窗口 send 同信号（点窗口外收起，原生菜单同款语义） |
| 2 | preload/index.ts | `on` 通道白名单加 `nuwax:dismiss-topbar-menus` |
| 3 | renderer/components/TrafficLightToolbar.tsx | `TopMenu` 改受控：`open`+`onOpenChange` state，useEffect 订阅 `nuwax:dismiss-topbar-menus` → `setOpen(false)`；宿主 document 内的既有收起行为（点其他按钮/再点同按钮）由 antd `onOpenChange` 原生保持 |

- 依据事件：`electron.d.ts` WebContents 类有 `focus`/`blur`（15565/16586 行实证）；焦点翻转不变式见上。
- 不动基座：`menuBar`/`TopMenu` 商业专属行为，基座 TrafficLightToolbar 不含自绘菜单栏（overlay 托管覆写），避免基座提交与 pin 流转。

## 测试

- 主进程：仿 `nuwaxBridgeHandlers.tokenScopes.test.ts` 的 electron mock，断言 guest focus / 窗口 blur 触发对应窗口收到 `nuwax:dismiss-topbar-menus`。
- 渲染层：视现有测试基建（@testing-library）补 TopMenu 受控收起用例；无基建则以主进程通道测试 + 门禁为界。

## 验证与遗留

- mac dev 无法直接目检菜单栏（Win/Linux 专属渲染），通道级验证走 CDP（guest focus 后渲染层收到信号）；最终以 Windows 真机打包版验收（随下次提测版本）。
- 遗留边界：顶行中部拖拽 spacer 上的点击（无 DOM 事件）仍不收起——与原生标题栏拖拽行为对齐，观察 QA 是否追报再定。
