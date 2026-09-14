# 计划：客户端设置入口迁移壳顶行 → nuwax web 用户区（仅 Nuwax 客户端）

- 日期：2026-09-14
- 线：release/v1.0.x（商业版）
- 状态：已实施+门禁全绿（2026-09-14；未提交，三仓各自待 commit）

## 需求

把壳顶行（TrafficLightToolbar）的「设置（客户端设置）」按钮入口迁到 nuwax PC web 项目：
放在左侧栏底部用户区右侧按钮区（`.footer-actions`）新增「设置」按钮，
**仅 Nuwax 客户端（商业宿主）渲染**；点击打开壳的「客户端配置」设置弹窗（落到 settings tab）。
社区 NuwaClaw 壳与纯浏览器不受影响（壳按钮保留、web 按钮不渲染）。

## 现状链路（已核实）

- 壳顶行设置按钮：基座 `TrafficLightToolbar.tsx`（settingsBtn，点击 → `App.tsx` `handleOpenSettings` → antd Modal「客户端配置」，`settings` tab 挂 overlay 私有 `SettingsPage`）。纯 renderer state，无 IPC。
- webview 桥 `window.NuwaClawBridge`（基座 `preload/webviewPerfBridge.ts` 暴露；后端 handler 基座注册 + overlay 托管 `main/ipc/nuwaxBridgeHandlers.ts`）：现无「打开设置」能力。
- 前端：单栏布局 `SidebarNavLayout` 底部 `.footer-actions` 渲染接口菜单 otherMenus；宿主判定收口 `utils/hostBridge` 的 `isDesktopHost()`（仅 nuwax/nuwawork 真）；桥调用一律经 hostBridge 封装。

## 方案（三层）

### 壳基座（nuwa-electron-shell@main）

1. `preload/webviewPerfBridge.ts`：`native` 命名空间新增 `openClientSettings()` → `ipcRenderer.invoke("native:openClientSettings")`。
2. `shared/types/webview.d.ts`：`NuwaClawBridgeNative` 补 `openWindow`（此前漏声明）+ `openClientSettings`。
3. `preload/index.ts`：`on()` validChannels 白名单加 `"nuwax:open-client-settings"`。
4. `renderer/App.tsx`：
   - 新增 useEffect 监听 `nuwax:open-client-settings` → `setActiveTab("settings") + setSettingsModalOpen(true)`（同 `menu:settings` 链路）；
   - `onOpenSettings={APP_NAME_IDENTIFIER === "nuwax" ? undefined : handleOpenSettings}`（nuwax 宿主移除顶行入口，入口由 web 承担）。
5. `renderer/components/TrafficLightToolbar.tsx`：`onOpenSettings` 改可选，不传则不渲染设置按钮；同步头注释。

### overlay（外层仓 overlay/，改源后 sync）

6. `overlay/.../main/ipc/nuwaxBridgeHandlers.ts`：新增 `ipcMain.handle("native:openClientSettings")` → `getMainWindow().webContents.send("nuwax:open-client-settings")`（设置弹窗是壳 renderer state，须事件转发，同 open-same-window 模式）。

### nuwax 前端（~/workspace/nuwax @ feat-dong.0930）

7. `src/types/global.d.ts`：`native.openClientSettings` 类型；顺手修正 `host.getProduct` 注释（nuwawork → nuwax 商业版）。
8. `src/utils/hostBridge/index.ts`：`native.openClientSettings()` 封装（无桥/旧宿主 → `{success:false}`，try/catch 降级）。
9. `src/utils/hostBridge/index.test.ts`：补 openClientSettings 三态用例。
10. `src/layouts/DynamicMenusLayout/SidebarNavLayout/index.tsx`：`.footer-actions` 末尾（最右）新增设置按钮，`isDesktopHost()` 门控，点击 `hostBridge.native.openClientSettings()`。桌面端锁 style3，ClassicLayout 无需改。
11. `src/locales/i18n/{zh-CN,en-US,zh-TW,zh-HK,ja-JP}.ts`：新增 `PC.Components.UserOperate.clientSettings`（设置/Settings/設定/設置/設定）。

## 门禁与验证

- overlay sync：`node scripts/sync-overlay.js` 后 `overlay:check` 一致。
- 商业门禁：`npm run test:commercial`（--no-env，不注 env）。
- 前端：`npx tsc -p tsconfig.typecheck.json --noEmit` + `npx vitest run src/utils/hostBridge`。
- 人工验收（后续）：真机 dev（NUWAX_APP_IDENTIFIER=nuwax）web 用户区按钮 → 弹窗落 settings tab；浏览器与社区宿主不渲染按钮。

## 边界与风险

- 壳顶行按钮仅对 nuwax 宿主隐藏（基座内既有 brand 分支模式），社区壳不动。
- web 按钮点击遇旧版壳（无新桥方法）→ `{success:false}` 静默；正式包壳/前端同源发版，仅 dev 瞬态。
- mac 应用菜单「设置...」、服务状态点入口保留不变。
- 打包版生效另需：前端 dist 重建 + bump 外层 nuwax 子模块 pin（沿 09-14 chat-split 先例，本轮不做）。
