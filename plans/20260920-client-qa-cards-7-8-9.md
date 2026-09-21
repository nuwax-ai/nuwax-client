# 客户端 QA 修复批次：卡7（壳层样式 8 单）/ 卡8（收银台 2432）/ 卡9（二级菜单 2434）

- 日期：2026-09-20 · 状态：修复已落工作树（未提交，见文末提交清单）
- 环境：mac dev（direct + gateway 双形态）、CDP 9223 驱动 webview + 9229 主进程 inspect
- 验证基线：test:commercial 1443 passed / tsc 本批文件零错误（总数 205≈基线 203）

## 卡8 bug2432 收银台无法退出（功能阻塞）——已修复并端到端验证

### 根因（载荷级实证）

- 收银台链路：`useSubscriptionPurchase` → `window.location.href = cashierUrl`（**pay.nuwax.com 外域整页跳转**，测试单 ¥0.10「测试专用」套餐复现）。
- **gateway 形态（打包版默认，webview origin=127.0.0.1:46800）下 Electron 40.8.2 的 webview 导航 API 失明**：
  - 元素/主进程两路 `canGoBack()/goBack()/canGoForward()/goForward()` 恒 false/空转；
  - 同一 `navigationHistory` 的 `getActiveIndex()/getAllEntries()/goToIndex()` 正常（主进程 `--inspect` 直读证实：entries=3、active=2 时 canGoBack()=false、goBack() 空转、goToIndex(1) 成功）；
  - https 直连形态（testagent）全部正常；与 `disable-http-cache` 无关（构建产物摘除开关对照排除）。
- 后果：收银台页工具栏「后退」置灰 → 无法退出；「前进」同理。

### 修复（导航真值通道）

| 仓库 | 文件 | 改动 |
| --- | --- | --- |
| overlay | main/ipc/nuwaxBridgeHandlers.ts | 新增 `nuwax:webview-nav-state/-go` IPC：读 `navigationHistory` 真值（activeIndex/entries），动作走 `goToIndex`；guest did-navigate/dom-ready 即向壳窗推送状态 |
| overlay | preload/index.ts | 暴露 `electronAPI.webviewNav.{state,go}` + `nuwax:webview-nav-state` 事件白名单 |
| overlay | shared/types/electron.d.ts | `webviewNav` 类型 |
| overlay | renderer/TrafficLightToolbar.tsx | 工具栏后退/前进（按钮+Win 窗口菜单）优先消费真值通道，无通道回退旧 props（社区基座行为不变） |
| 基座 | main/main.ts | mac 系统菜单 后退/前进 同改 `goToIndex`（try/catch 回退 goBack） |
| overlay | nuwaxBridgeHandlers.tokenScopes.test.ts | electron mock 补 isDestroyed/getType 成形状 |

验证：gateway 形态 收银台→后退按钮→回订阅页→前进回收银台 全通；直连形态不回归。

### 收银台样式

mac gateway 形态截图无异常（无溢出/裁切/遮挡）——待 Windows 真机走查（DPI/满宽工具栏）。

## 卡9 bug2434 二级菜单上沿超出——核验完成，无需改动

- PC 修复 017646ae59 **已在当前 dist**（子模块 pin 0127b6545）：HoverScrollbar padTop=3px、标题无负 margin。
- 客户端实测（/square 二级列）：列 padTop=36（shellAvoid.TOP 避让）+ 容器 3px → 标题 top=39、**完整无裁切**（content 盒顶即标题顶，未顶出 overflow:hidden）。
- 与 2395 同族缺陷在当前构建不复现；QA 所报疑为更早构建或 Windows 形态——win 真机终验。

## 卡7 bug2428 切换语言无效果——已修复并端到端验证

根因：壳「客户端设置→语言」只重载壳页（`window.location.reload()` 在宿主 renderer），主界面 webview 不跟随。

| 仓库 | 文件 | 改动 |
| --- | --- | --- |
| 基座 | main/ipc/i18nHandlers.ts | `i18n:setLang` 后向 webview guest 下发 host-command `{type:'set-lang',lang}` + 800ms 后重载 guest（无 guest 时 no-op） |
| nuwax | types/global.d.ts | HostCommand 联合类型加 `set-lang`（additive，不改既有协议名） |
| nuwax | services/hostBridgeEvents.ts | `set-lang` 分支：normalizeLang→markLangUserSet→fetchAndApplyLangMap→saveUserLang（尽力持久化） |

验证（webview=:3000 本地源）：切 en-us → web UI 全英文 → 切 zh-cn 回中文，双向闭环。

## 卡7 bug2439 个人资料悬浮框压工具栏——机制修复，待目检

根因（代码级）：Setting Modal（个人中心）未钉 zIndex，antd 弹层逐次爬升可越过壳固定层 1099–1101 → 遮罩盖住工具栏。
修复：nuwax `layouts/Setting/index.tsx` Modal 加 `zIndex={1000}`（antd 默认基线，PC web 无影响）。「过大」（1000×750 定尺寸）属设计口径，未动。

## 卡7 其余四单——mac 侧无复现，转 Windows 真机走查清单

- 2427 工具栏菜单不自动关：Win/Linux antd Dropdown；代码层无显性缺陷，需 win 复现定位。
- 2429 右上角按钮没右对齐：所指不明（Win 三键贴角 / 页面右上按钮二选一），需 QA 截图。
- 2433 我的订单样式：mac gateway 截图结构正常（/tmp/qa/my-orders.png）。
- 2435 管理页样式：mac 抽样 agent-dev/skill-manage 顶部衔接与右上按钮均正常（/tmp/qa/2435-*.png）。

## 提交清单（未提交，待目检后三仓落）

- 基座（push origin/main 前先 `npm run check:pin`）：main.ts、ipc/i18nHandlers.ts —— 显式 add，排除 overlay 产物。
- overlay（外层仓）：nuwaxBridgeHandlers.ts、tokenScopes.test.ts、preload/index.ts、electron.d.ts、TrafficLightToolbar.tsx —— 注意 TrafficLightToolbar/nuwaxBridgeHandlers 同时含上批待目检 WIP（ROW_H 36→28、dev 直连注释收尾），提交时会一并带入。
- nuwax（独立检出 → worktree+rebase origin/feat-dong.0930）：global.d.ts、hostBridgeEvents.ts、Setting/index.tsx —— 进打包版还需 dist 重建 + 外层 pin bump。

## 偏离记录

- dev 环境重启次数多于常规（CDP 9223/9229 调试形态）——最终已恢复标准 base:dev 常驻树（direct 模式，/tmp/nuwax-dev-electron.log）。
- ~/.nuwax step1_config.nuwaxLoadMode 曾切 gateway 验证，已还原 direct；产生 3 笔 ¥0.10 测试订单（未支付，可后台取消）。
