# bug2427 Win/Linux 工具栏菜单不自动收起——修复计划

- 日期：2026-09-21 · 禅道：zt.nuwax.com bugID=2427（激活，严重程度 1，指派罗东，赵立坤 2026-09-18 报）
- 状态：2026-09-23 复查发现原实现只注册了 `nuwax:guest-pointer-down` 主进程监听，guest preload 从未发送该事件；现补齐发送端，待 Windows 真机验收。
- 症状（bug 截图 fileID=3213，红字批注）：点工具栏菜单（如「编辑(E)」）弹出下拉后，再点页面内左侧导航（QA 称「系统菜单」），工具栏菜单不收起。

## 根因（代码级）

- Win/Linux 顶行自绘菜单栏 = 5 个 antd `Dropdown trigger={["click"]}`（overlay `renderer/components/TrafficLightToolbar.tsx` 的 `TopMenu`），浮于 `NuwaxHostWebview` 之上。
- antd/rc-trigger 的「点外部收起」监听的是**宿主 renderer document** 的 mousedown；而页面内容在 **webview guest 独立文档**里，guest 内点击不冒泡到宿主 document → 收起逻辑永不触发，菜单挂住。QA 所点左侧导航恰是 guest 内容，必现。
- 同理宿主窗口失焦（点窗口外/任务栏）antd 也不收起；顶行中部拖拽 spacer（app-region:drag）区域点击无 DOM 事件，属同类边界（本次一并由窗口/焦点信号覆盖不了，见「遗留」）。
- 2026-09-23 复查：只靠 guest `focus` 不可靠。菜单打开时 guest 可仍保持焦点，继续点击 guest 不产生新 `focus`；先前写入主进程的 `nuwax:guest-pointer-down` 监听没有对应发送端，因此这一路一直无效。
- mac 不受影响：`menuBar` 仅 `!isMac` 渲染，mac 走系统原生菜单。

## 修复方案（全 overlay，guest 点击与焦点信号）

主进程广播「收起信号」→ 工具栏菜单改受控 open，收到即关：

| # | 文件（均在 overlay crates/agent-electron-client/src） | 改动 |
| --- | --- | --- |
| 1 | main/ipc/nuwaxBridgeHandlers.ts | 收到 guest `pointerdown` IPC 时广播 `nuwax:dismiss-topbar-menus`；guest `focus` 与 `browser-window-blur` 继续作为辅助信号 |
| 2 | preload/index.ts | `on` 通道白名单加 `nuwax:dismiss-topbar-menus` |
| 3 | renderer/components/TrafficLightToolbar.tsx | `TopMenu` 改受控：`open`+`onOpenChange` state，useEffect 订阅 `nuwax:dismiss-topbar-menus` → `setOpen(false)`；宿主 document 内的既有收起行为（点其他按钮/再点同按钮）由 antd `onOpenChange` 原生保持 |
| 4 | preload/webviewPerfBridge.ts | guest `window` 捕获阶段监听 `pointerdown`，向已存在的主进程监听发送 `nuwax:guest-pointer-down`；guest 已保持焦点时仍能收起菜单 |

- `focus` 不能代替页面内点击；guest 保持焦点时不会重复产生 `focus`。
- 不动基座：`menuBar`/`TopMenu` 商业专属行为，基座 TrafficLightToolbar 不含自绘菜单栏（overlay 托管覆写），避免基座提交与 pin 流转。

## 测试

- 主进程：断言 guest `pointerdown` / `focus` 与窗口 `blur` 都能发出收起信号，非 webview sender 被拒绝。
- guest preload：断言捕获阶段注册 `pointerdown` 并发送 `nuwax:guest-pointer-down`；针对性测试共 8 项通过。
- 渲染层：视现有测试基建（@testing-library）补 TopMenu 受控收起用例；无基建则以主进程通道测试 + 门禁为界。

## 验证与遗留

- mac dev 无法直接目检菜单栏（Win/Linux 专属渲染）；最终以 Windows 真机打包版验收（随下次提测版本）。
- 遗留边界：顶行中部拖拽 spacer 上的点击（无 DOM 事件）仍不收起——与原生标题栏拖拽行为对齐，观察 QA 是否追报再定。
