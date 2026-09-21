# bug2473 客户端页面内右键菜单（复制/粘贴/图片另存为/复制图片）——实施记录

- 日期：2026-09-21 · 禅道：zt.nuwax.com bugID=2473（PC 会话页无法使用鼠标右键复制内容；要求图片可另存为/复制；完善客户端页面内右键功能）
- 状态：修复已实施（全 overlay + nuwax 前端撤补偿逻辑）；门禁 test:commercial 1513 passed（基线 1498 + 新增 15）/ tsc 205=基线零新增；⏳mac dev 冒烟 + win 真机验收（随下次提测构建）

## 根因（代码级）

- Electron 只有应用监听 `webContents` 的 `context-menu` 事件并 `menu.popup()` 才会有右键菜单（Chromium 原生菜单默认禁用）；全仓（壳主进程/宿主渲染层/nuwax 前端）此前**零监听** → 客户端任何页面右键无任何反应。
- 键盘 ⌘C/Ctrl+C 不受影响（走标准应用菜单 `menu:editAction` → `resolveEditTargetWebContents` 显式路由），缺的是右键这一路。
- 聊天内图片是历史补偿：前端 `OptimizedImage` 在商业宿主对图片右键 `preventDefault` 并直调 `native:saveImage`（无菜单、无「复制图片」）——当时没有菜单的权宜设计，本次统一收回菜单交互。

## 修复方案（全 overlay + 前端一行撤除）

| # | 文件 | 改动 |
| --- | --- | --- |
| 1 | overlay `main/services/contextMenu.ts`（新） | 右键菜单服务：`app.on("web-contents-created")` + 存量补挂（同 nav 真值/顶栏收起钩子先例）；只挂 `getType()` 为 `webview`/`window`（跳过 devtools/background-page）；模板按上下文构建——图片（另存为/复制图片/复制图片地址，linkURL/选区补项）/ 链接（复制链接）/ 可编辑（撤销重做｜剪切复制粘贴删除｜全选，editFlags 守卫）/ 纯选区（复制/全选）/ 兜底（后退/前进/重新加载）；编辑命令显式作用于发射事件的 wc（裸 role 在 webview 场景不可用，同 windowHandlers 结论）；`copyImageAt(params.x, params.y)` 复制图片；popup 定位用 `screen.getCursorScreenPoint()`（guest 的 params.x/y 非屏幕坐标）；后退/前进用 navigationHistory entries 真值 + `goToIndex`（gateway origin 下 `canGoBack()` 恒 false，bug 2432 防线）；另存失败（非取消）`dialog.showErrorBox` |
| 2 | overlay `main/ipc/nuwaxBridgeHandlers.ts` | `native:saveImage` handler 体抽为本地 `performSaveImage(opts, frameUrl)`（IPC 与菜单共用；token/generation/transfers 闭包原样），IPC 通道保留（老 dist 兼容）；boot 区接线 `installContextMenuService({ saveImage: performSaveImage })` |
| 3 | overlay 4 语言文件 | `Claw.ContextMenu.*` 14 键（undo/redo/cut/copy/paste/delete/selectAll/saveImageAs/copyImage/copyImageUrl/copyLink/back/forward/reload）；基座 locales 不动（overlay-only 功能，键齐由 `i18nLocales.test.ts` 四文件一致性测试兜底） |
| 4 | nuwax 前端 `src/components/MarkdownRenderer/OptimizedImage.tsx` | 删 `handleContextMenu`/`onContextMenu` 及 `message`/`hostBridge` import——商业宿主聊天图片右键改由主进程菜单接管（另存为/复制图片/复制图片地址），社区宿主/浏览器行为不变（原拦截本就仅商业宿主生效）；dist 重建随源码提交 |

## 与周边机制的边界（已核实）

- 前端 antd 自绘右键（会话列表/文件树/项目列表等 `trigger=["contextMenu"]`）会 `preventDefault` DOM 事件 → Chromium 不请求菜单、主进程 `context-menu` 不触发，**天然无双重菜单**。
- Monaco `contextmenu:false`（diff 视图自禁）区域右键落主菜单（复制选区），预期内。
- webviewPolicy 弹窗窗（sandbox:true）同经 `web-contents-created`，一并获得菜单，预期内。
- 菜单弹出即窗口获焦语义不变；guest focus 收起顶栏菜单信号（bug 2427）不受影响。

## 测试

- 新增 `contextMenu.test.ts` 15 用例：安装钩子（存量过滤 devtools/background、web-contents-created 新建、销毁跳过）；弹出与动作（选区复制作用于发射 wc、popup 用光标点、图片三动作+linkURL/选区补项、另存失败错误框/取消静默、导航真值 goToIndex）；模板构建器纯函数（可编辑满旗/零旗无悬空分隔线、链接、图片、编辑动作路由全集、兜底真值开关、canCopy=false 守卫）。
- 门禁：`npm run test:commercial` 1513 passed（基线 1498 + 15）；`tsc --noEmit -p tsconfig.json` 205 条=基线，本批文件零错误（修型前 207=205+2 已修）。

## 验证与遗留

- 已获运行时证据（mac dev + inspector 实证，2026-09-21 晚）：
  - `context-menu` 监听已挂载：webview guest `listenerCount=2`（含 Electron webview 转发内置层）、宿主窗 `=1`；
  - guest DOM contextmenu 事件正常触发且**不被前端 preventDefault**（CDP 合成右键 + 捕获监听实证 def:false——撤除 OptimizedImage 拦截后菜单不再被前端吃掉）；
  - 主进程直发 `context-menu` 事件 → 处理器执行零异常（无 [ContextMenu] 错误日志）。
- mac 视觉冒烟受阻（环境非代码）：机器锁屏无人值守，后台 app 的 NSMenu popup 即开即关、整屏截屏为锁屏帧；CDP 合成右键只到 DOM 层不触发 Chromium 原生菜单路径（Puppeteer 同款已知行为）。留待解锁后/打包版人工冒烟。
- win 真机验收随下次提测构建（bug 为 PC 报障）。
- 遗留：视频/音频右键菜单未做（v1 不进）；`native:saveImage` IPC 通道保留供老 dist，待后续版本全量切换后可回收。
