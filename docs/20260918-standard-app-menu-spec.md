# 标准应用菜单规范 v1（2026-09-18）

> 批次：标准应用菜单重设计 + 编辑菜单不可用修复 + 快捷键功能菜单化。
> 三仓落点：基座 [6502dc9b](https://github.com/nuwax-ai/nuwa-electron-shell/commit/6502dc9b)（main）·
> 前端 [b2aedab7d](https://github.com/nuwax-ai/nuwax/commit/b2aedab7d)（feat-dong.0930，dist 随 0871e065a）·
> 外层 37061e45（release/v1.0.x，双 pin bump）。
> 本文档是菜单的**长期规范**（新增入口须按「维护规则」节执行），兼作本批方案留存。

## 1. 背景与目标

1. 提测反馈：应用菜单「编辑」下选项不可用（mac 主因，win 顺带加固）。
2. 应用菜单补标准入口：「关于」「检查更新」进应用菜单，整体结构对齐平台通行规范。
3. nuwax PC web 已有快捷键能力（新建任务 ⌘N/Ctrl+N、全局搜索 ⌘K/Ctrl+K）菜单化，工作空间目录、日志目录等壳侧能力一并上菜单。

## 2. 菜单结构（双轨对齐）

mac 走原生菜单（`createMenu()`，仅 darwin 构建）；Win/Linux 原生菜单置 null，由 renderer 自绘（`TrafficLightToolbar`，antd Dropdown）。两轨结构对齐如下：

| 菜单 | mac 原生（六菜单） | win 自绘（五菜单） |
|---|---|---|
| **应用菜单** / 关于(A) | 关于（壳设置弹窗·关于页）· **检查更新…**（showUpdateDialogFlow，托盘同款）· 设置… ⌘, · 服务 · 隐藏/隐藏其他/全部显示 · 退出 ⌘Q | 关于与检查更新（原有，不动） |
| **文件(F)** | **新建任务 ⌘N · 搜索 ⌘K · ── · 更改工作空间目录… · 打开工作空间目录** | 同 mac（本批新增） |
| **编辑** | 撤销 ⌘Z · 重做 ⇧⌘Z · 剪切 ⌘X · 拷贝 ⌘C · 粘贴 ⌘V · 全选 ⌘A（显式路由） | 同六项（原有，后端路由本批加固） |
| **视图** | 刷新页面 ⌘R · 进入全屏 ⇧⌘F · 切换开发者工具 | —（刷新在窗口(W)菜单） |
| **窗口** | 后退 ⌘[ · 前进 ⌘] · 最小化/缩放/关闭窗口/前置全部窗口 | 后退/前进/刷新 + 最小化/最大化/关闭（原有） |
| **帮助** | 打开日志目录 | 打开日志目录（原有） |

### 规则条款（v1 定稿）

1. **双轨结构对齐**：任何新增菜单入口必须 mac 原生与 win 自绘两轨同步评估（都加 / 都不加 / 明确记录只加一轨的理由）。
2. **编辑命令一律显式路由活跃 webContents，禁裸 role**（见 §3）。
3. **关于 = 壳设置弹窗 about tab**（不用 Electron 原生 `role:"about"` 默认框）；**检查更新 = `showUpdateDialogFlow()` 原生弹窗流**（与托盘同款），收口在应用菜单（mac 惯例），不进帮助；**帮助菜单 = 排障入口**（日志目录）。
4. 菜单文案双轨**硬编码中文**（与自绘轨现状约定一致；i18n 有意不进本批——菜单仅在 createWindow 构建一次，接 i18n 须同时解决语言切换重建，成本另议）。
5. 窗口类 role（隐藏/最小化/关闭/退出/全屏/devtools）无 webview 路由问题，保留原生 role 快捷键。

## 3. 编辑菜单修复（根因与设计）

**根因**：mac 编辑菜单原为裸 `role`（undo/cut/copy/paste/selectAll）。本产品所有可编辑内容都在 `<webview>` guest webContents 里，Electron role 的 enable 校验与命令分发落在**宿主页面** → 菜单恒灰，且 ⌘C/V/Z/A 等编辑快捷键同样失灵（无菜单 accelerator 时按键也到不了正确目标）。仓库内先例已内化此结论：「窗口」菜单后退/前进、win 自绘编辑菜单（`menu:editAction`）都是显式路由。

**修复**：`windowHandlers.ts` 新增 `resolveEditTargetWebContents(getMainWindow)` 单一裁定点：

1. `webContents.getFocusedWebContents()` 有效 → 直接用（guest 聚焦即 guest；二级窗口聚焦时为其自身 guest，保留"在哪编辑就作用在哪"）；
2. 焦点无效 → 从 `getAllWebContents()` 按 `hostWebContents === 主窗口 webContents` 精确筛出主窗口 webview guest 兜底（覆盖 Win 自绘菜单点击后焦点被宿主按钮抢走）；
3. 再兜底主窗口宿主 webContents（无 guest 时壳内输入场景）。

mac 菜单项 = 显式 click + 原生 accelerator（⌘Z/⇧⌘Z/⌘X/⌘C/⌘V/⌘A）调 `EDIT_ACTIONS[action](resolve(...))`；win `menu:editAction` IPC handler 同步换用该路由器。绑定 accelerator 后菜单吃键 → click 转发进 guest，与 guest `before-input-event` 拦截不构成双发（⌘N 场景同理）。

## 4. 菜单项接线总表

| 菜单项 | 通道/实现 | 链路 |
|---|---|---|
| 关于 | `menu:about`（main→renderer，preload on 白名单） | mac 菜单 click → App.tsx 监听 → 设置弹窗 about tab |
| 设置 | `menu:settings`（既有） | 同上，settings tab |
| 检查更新 | `showUpdateDialogFlow()`（主进程直调） | 与托盘/帮助旧入口同款弹窗流 |
| 新建任务 / 搜索 | `nuwax:host-command` `{type:"new-task"}` / `{type:"open-search"}` | mac：主进程 `sendHostCommandToMainWindowGuests`（hostActivity guest 登记集合，did-attach-webview 登记、只含主窗口 guest）；win：App.tsx 经 `webviewRef.sendHostCommand`（NuwaxHostWebviewHandle）→ guest preload（webviewPerfBridge）→ 前端 `hostBridgeEvents` 分发（`createNewTask` / `openSearch`，openSearch 为可选 handler，经典布局不注入 no-op）→ SidebarNavLayout 注入 `setOpenSearchModal(true)` |
| 更改/打开工作空间目录 | `menu:workspace` `{action:"modify"\|"open"}` + `services/core/workspaceDir.ts`（收口 util） | mac 菜单 → App.tsx 监听 → util；win 菜单 props 回调 → util；SettingsPage「工作区目录」行委托同一 util（系统目录选择器写 `step1_config.workspaceDir` / `shell.openPath`） |
| 打开日志目录 | `openLogDirectory()`（自 appHandlers `log:openDir` handler 抽出，共用） | mac 帮助菜单 / win 帮助菜单（经既有 `log.openDir` 桥） |
| 编辑六命令 | `EDIT_ACTIONS` + `resolveEditTargetWebContents` | mac click / win `menu:editAction` IPC，同一路由器 |

前端侧 `open-search` 为新增 `HostCommand` 联合成员（`src/types/global.d.ts`），与 `new-task` 同构三件套：类型 → `hostBridgeEvents` switch → 布局注入。

## 5. 快捷键绑定（mac 原生菜单 accelerator）

⌘, 设置 · ⌘N 新建任务 · ⌘K 搜索 · ⌘Z/⇧⌘Z 撤销/重做 · ⌘X/⌘C/⌘V/⌘A 编辑 · ⌘R 刷新 · ⇧⌘F 全屏 · ⌘[/⌘] 后退/前进 · role 自带：⌘H 隐藏 / ⌘M 最小化 / ⌘W 关闭 / ⌘Q 退出 / ⌥⌘I devtools。

冲突分析：⌘K/⌘N 绑定后由菜单吃键再下发 host-command（此前 guest 前端 keydown 监听不再收到，行为等效；搜索为**打开**语义而非前端原生 toggle）。前端无 ⌘F/⌘[ 使用。Win/Linux 无原生菜单，Ctrl 组合键直达 guest（⌘N 拦截链维持现状），仅菜单点击为新增路径。

## 6. 仓库落点与文件清单

**基座（nuwa-electron-shell，非托管部分）**：`main.ts`（createMenu 重写）、`ipc/windowHandlers.ts`（+`windowHandlers.test.ts`，EDIT_ACTIONS 导出+路由器）、`ipc/appHandlers.ts`（openLogDirectory 抽出）、`services/hostActivity.ts`（+test，sendHostCommandToMainWindowGuests）、`renderer/App.tsx`（menu:about/menu:workspace 监听 + 菜单 props）、`renderer/services/core/workspaceDir.ts`（新，收口 util）。

**基座（overlay 托管文件的基座 git 侧）**：`preload/index.ts`（on 白名单 +`menu:about`/`menu:workspace` 两行）、`TrafficLightToolbar.tsx`（文件(F)菜单 + 4 个可选 props）。这两个文件与 overlay 版存在商业分叉（cua 桥 / ROW_H=40 / 手势化拖拽），进基座采用「`git show HEAD:` 基座版 + 本批补丁 → `hash-object`+`update-index` staged」手法，商业代码零泄漏。

**overlay/**：preload、TrafficLightToolbar、SettingsPage（工作区行委托 util）同步 overlay 源（铁律：托管文件必须改 overlay 源）。

**前端（nuwax）**：`src/types/global.d.ts`、`src/services/hostBridgeEvents.ts`（+test）、`src/layouts/DynamicMenusLayout/SidebarNavLayout/index.tsx`；dist 随源码重建（dev 烤法 `build:dev`，`git add -f dist/` + `--no-verify`）。

## 7. 验证状态

- 门禁：商业轨 vitest **1422 passed** / 社区轨隔离 worktree 副本 **1347 passed** / tsc 205 存量基线零新增 / check:pin 通过（8 个非托管改动均本批中立文件）。
- 新增测试：`resolveEditTargetWebContents` 路由 7 例（焦点优先/焦点失守兜底/已销毁跳过/宿主兜底/主窗口无效返回 null）、`sendHostCommandToMainWindowGuests` 2 例、前端 open-search 分发 2 例。
- **dev 冒烟未做**（本机常驻 dev 会话勿杀）。打包版/提测重点：webview 输入框内**菜单点击与快捷键两种路径**的撤销/剪切/拷贝/粘贴/全选；⌘K 搜索弹窗与 ⌘N 新建任务；关于落设置弹窗 about tab；更改/打开工作空间目录；中文输入法下 Cmd 组合键。win 真机验文件(F)菜单前须先部署前端到 testagent 源（win-pc 前端来自远程）。

## 8. 维护规则（后续改菜单先读这节）

1. 新增菜单入口：先过 §2 规则条款（双轨评估、编辑类必须走路由器、文案硬编码中文）。
2. 新增「壳→guest 动作」：扩 `HostCommand` 联合（前端 `global.d.ts`）→ `hostBridgeEvents` switch → 布局注入，与 `new-task`/`open-search` 同构；壳侧经 `sendHostCommandToMainWindowGuests`（mac）/`webviewRef.sendHostCommand`（win 自绘），**不要新开通道**。
3. 新增 main→renderer 菜单通道：`preload on()` 白名单（基座 git 版与 overlay 版**两份都要加**）+ App.tsx 监听。
4. 改 overlay 托管文件（preload/TrafficLightToolbar/SettingsPage/locales 等 10 文件）：商业相关只改 overlay 源；纯中立小改动要进基座 git 时用 §6 的 staged 手法，**禁止整文件 add 工作树版**。
5. 菜单不随语言切换重建（createWindow 一次性）；文案 i18n 化是独立议题（须连同重建机制一起设计）。
