# 实施计划：desktop-capability-ports

- 对应 spec：`specs/desktop-capability-ports.md`
- 状态：已接受（2026-10-15 用户要求以 worktree 直接实施）
- worktree：`.claude/worktrees/desktop-capability-ports`，分支 `refactor/desktop-capability-ports`，基线 `codex/computer-use-product@2dbc6221`（含 release/v3.0.x `b6be7b42`）

## 实施顺序（每步跑对应域测试再进入下一步）

1. **套件端口**：`_kit` 生命周期 v2、activities、settings、session、windows、agent 类型；registry 支持 `lockedOff`/`bridge`/`requests`/`beforeReady`/`agentServers`、`features:registered`、`createAgentSessions`、`settle`。local-files 改为 `lockedOff`、请求策略改为清单声明；capture 改用 `settings` 与 `activities`。
2. **宿主实现**：`main/services/featureHost.ts`（MCP 条目端口、托盘 activities 汇总）；`nuwaxBridgeHandlers` 注入端口、canUse 走 `isFeatureCapabilityAvailable`；`commercialAuth` 走 lifecycle v2；`trayManager` 渲染 activities；`main.ts` 用 `prepareDesktopFeaturesBeforeReady` 与 `runDesktopActivity`；请求门两处改通用入口。
3. **Computer Use 迁移**：`services/cua/*` → `main/features/computer-use/*`，`ipc/cuaRuntimeHandlers` 并入特性 `register`；db/binaryLocator/mcp/i18n/tray 依赖改走端口；`acpEngine` 改用 `createAgentSessions`；preload、renderer（含 SettingsPage 区块）、shared 类型迁移。
4. **守卫与文档**：边界检查 R5（_kit 不得出现特性 id；registry 只引特性入口）；`docs/feature-modules.md` 更新端口说明。
5. **验证**：商业门、隔离社区门、脚本门、check:pin、overlay:check、host-bridge:check、esbuild；独立 verifier 复核；质量自查。

## 风险与回退

| 风险 | 缓解 | 回退 |
|---|---|---|
| Computer Use 分支继续提交导致移植冲突 | 迁移以纯搬迁为主，提交说明列出新旧路径映射 | 本分支整体不合入，不影响 Computer Use 分支 |
| 退出/会话时序细微变化 | 生命周期 v2 单测 + commercialAuth/acpEngine 回归 | 按步骤提交，可单独回退 |
| 社区基座测试受 overlay 文件删除影响 | 跑测前 `overlay:clean` 再同步，社区门在隔离副本 | — |

## 不在本期

打包资源注册表、统一权限端口、本地文件缓存实现、acpEngine 去整份覆写（需基座钩子）。
