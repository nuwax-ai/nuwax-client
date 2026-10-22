# 意图：桌面扩展能力统一接入（特性端口化 + Computer Use 入框架）

- 日期：2026-10-15　发起人：dongdada29
- 状态：已接受（用户 2026-10-15 认可整体规划，并要求以 worktree 方式直接实施）

## 问题

录制（capture）、本地文件直访（local-files）、Computer Use 都是客户端的扩展能力，但接入方式不统一：

1. Computer Use 不在 `main/features` 特性框架内：`nuwaxBridgeHandlers` 内联注册约 10 个 `cua:*` 通道和启动钩子，`commercialAuth` 直接 import `suspendCua`，`trayManager` 自带 `computerUseStopAction`，`preload/index.ts` 手写命名空间，`App.tsx` 用 `APP_NAME_IDENTIFIER` 判断，`acpEngine.ts`（整份覆写基座）直接 import CUA 会话凭据类。它不能用 `features.<id>.enabled` 关闭，也不受边界检查约束。
2. 特性套件 `_kit` 被具体能力撑破：`FeatureContext` 含 capture 专属的录制托盘回调、local-files 专属的 `workspace`；`features/index.ts` 硬编码 local-files 强关和请求授权、导出 capture 专属函数；`canUse` 主进程/preload 两侧按命名空间写死 capture、localFiles 的判断。
3. 下一步要做本地文件缓存。若在现状上继续加，会成为第四种各自管存储与生命周期的写法。

## 预期结果

1. 三项能力都以 `DesktopFeature` 接入；Computer Use 位于 `main|preload|renderer|shared/features/computer-use`，可由 `features.computer-use.enabled` 关闭，关闭时不注册通道、不显示托盘/设置入口、不向 Agent 注入工具。
2. `_kit` 与 `FeatureContext` 不含任何特性专属字段，边界检查新增规则强制。客户端其余代码不再出现 `cua`/`capture`/`local-files` 的专属分支（public contract 引用除外）。
3. 现有用户可观察行为不变：IPC 通道名、preload 方法、设置页、托盘菜单项、快捷键、MCP 配置落点（`mcp_local_config` 中的 `cua` 条目）、`step1_config` 中的 Computer Use 偏好字段、local-files 在 release 线强关、canUse 结果均保持。
4. 本地文件缓存等后续能力可直接使用通用端口（数据目录、设置、生命周期、身份/工作区），无需再改接缝文件。

## 受影响的能力面

商业 overlay：`main/features/**`、`main/ipc/{nuwaxBridgeHandlers,commercialAuth,cuaRuntimeHandlers}`、`main/services/cua/**`（迁走）、`main/services/engines/acp/acpEngine.ts`、`main/window/trayManager.ts`、`main/main.ts`、`main/services/{businessRequestRouting,sessionAuthInjection}.ts`、`preload/{index,canUse,cuaControls}.ts`、`preload/features/**`、`renderer/{App.tsx,components/CuaControls.tsx,components/pages/SettingsPage.tsx}`、`shared/{hostCapabilities,cuaPresentation,types/cuaRuntime,types/electron.d.ts}`、`scripts/build/build-main-esbuild.js`、`scripts/check-feature-boundaries.mjs`、`docs/feature-modules.md`。

外部暴露面不变：业务页 `NuwaClawBridge` 契约、canUse 白名单、宿主壳 `electronAPI.computerUse`、IPC 通道名均不改。不涉及基座仓与前端仓。

## 约束

- 基线叠在 `codex/computer-use-product@2dbc6221`（已含 release/v3.0.x 最新 `b6be7b42`），迁移的是最新 Computer Use 代码；合入顺序 release ← Computer Use 分支 ← 本分支。Computer Use 分支后续新提交需要在本分支按新目录移植。
- 只改 overlay，不改基座与前端；不推送、不合并、不发布。
- 等价重构：不改 Computer Use 状态机、网关、授权、daemon 启停的语义；退出清理时序允许「更早开始撤销」，但等待上限不得缩短。
- local-files 继续在 release 线强关（改为清单声明）；`codex/local-file-access` 只需删一行声明即可恢复。

## 本期做 / 本期不做

本期做：
- 生命周期 v2（会话失效即撤销、服务启动前可等待、服务停止可等待并回报失败、退出收尾可等待）。
- 进行中操作（托盘操作项）端口，替换录制与 Computer Use 的专属托盘字段。
- 设置读写、特性数据目录、宿主主窗口、登录态查询端口；Agent 端口（本地 MCP 条目登记、Node 运行时定位、Agent 会话参与者）。
- 能力声明：canUse 的命名空间归属与探测下沉到各特性；请求授权与强关改为清单声明。
- Computer Use 整体迁入特性框架；边界检查增加 R5。

本期不做：
- **统一系统权限端口**：核实后 Computer Use 的辅助功能/屏幕录制授权归属独立的 Nuwax Computer Use 程序（helper 自有 TCC 身份），与客户端自身的录屏权限不是同一授权，没有真实的共同使用者。
- **打包资源注册表化**：发布关键路径，仅两种异构资源（Rust 构建 helper / 已核验 LGPL ffmpeg），且只能用真实 pack 验证；另立专项。
- **本地文件缓存实现**：缓存对象（本机会话预览/缩略图，还是云端电脑文件落盘）待产品确认，另走 intent。
- **acpEngine 去整份覆写**：需要基座提供产品中立的会话钩子，走基座 PR。

## 开放问题

- 本地文件缓存的对象与安全边界——待用户确认（不阻塞本期）。
- 本分支与 Computer Use 分支的合入窗口——待用户安排（本期不推送）。
