# 最近 Codex 分支合并检查

日期：2026-10-14。目标：本地 `release/v3.0.x`，起点 `0c1ff50203872f81dc8a9cc2b03ca4c4b7e11549`。按用户补充要求，仅整合最近的有效功能分支，旧分支不处理。

## 分支结论

| 分支 | 结论 |
| --- | --- |
| `codex/local-file-access`（2026-10-13） | 合入。本机文件列表、搜索、流式预览、系统打开/定位、原子保存、工作区 ZIP，以及验收修复均尚未进入 release。前端同时整合 `d1992b353290af378f1b4e253fd26337dacfe3a2`，生成合并提交 `7cd54922b58ed68b80141db1932a5d153ac41548`，保留原前端 `b5c53603ea328bb3d788d9a2593e54e28a75b53c` 的全部增量。 |
| `codex/computer-use-product`（2026-10-13） | 合入。带入 CUA 会话凭据隔离、暂停/恢复/急停、窗口范围、浮窗、资源清理及脱敏诊断。保留 release 较新的产物 pin，不采用该分支为旧验收包生成的 `nuwax-dist` pin。 |
| `codex/mac-notary-ci` / `codex/windows-capture-ci-diagnostic`（2026-10-13/14） | 无需合入。正式的公证和采集工具链修复及其回归已在 release；额外差异主要是临时诊断入口和替换通用 smoke workflow 的实验配置。 |

旧 BUG 补丁、历史 IM 方案和现场备份均未重新合入，分支未删除。此次仅本地合并，不推送、不打 tag、不发布安装包。

## 合并处置

- 特性注册表同时保留截图/录屏、开源声明和本机文件；共享生命周期和 recording 控制均保留。
- 删除旧 `localFiles:pickDirectory` IPC 注册，避免与新特性的同名 handler 重复注册；目录选择及授权归本机文件特性统一管理。
- 统一 preload 命名空间导入及桥接线，维持 capture 的商业宿主/顶层文档门控；`localFiles` 满足现有必选契约，其实际调用仍通过主进程权限校验。
- 托盘同时保留 CUA 急停及录制暂停/停止。退出时仅执行一次特性释放，在引擎退出前撤销文件授权。
- 基座仍为 `e75c9d5cd334e203520aaee6fecb6c84ed4561e5`。核对 CUA 分支旧基座 `484ff6b36` 后的重叠：ACP 文件仅新增 NW-041 的对话级取消说明，已同步到商业 overlay 并登记对象/内容摘要。实际会话解析及并行隔离继续消费当前基座。

## 提交前质量自查

- **内聚：通过。** `src/main/features/local-files/index.ts:131` 集中管理 context、grant、请求和资源；`:446` 统一撤销。`src/main/services/cua/sessionAuthority.ts:10` / `taskController.ts:18` 分别管理凭据与任务状态，`computerUse.ts:1008` 在等待清理队列前同步撤权。
- **分层：通过。** 上述路径均位于 `overlay/crates/agent-electron-client/`。组合根 `src/main/ipc/nuwaxBridgeHandlers.ts:308` 注入身份和工作区；前端通过 `src/features/client-shell/localFileService.ts` 及可选宿主桥消费，不引入 Electron。特性边界、前端依赖分层和桥契约检查均通过。
- **维护：通过。** 权限、导航与会话代次回归保留；新增功能没有覆盖既有 capture 注册和录制动作。`src/main/window/trayManager.ts:215` 的控制入口共存；ACP 的基座演进审查绑定在 `overlay-base-reviews.json`，后续漂移会阻断。

结论：当前批次可本地合入 release；真实账号和跨平台安装包验收仍按各功能原验收记录执行。

## 本次验证

全部测试在隔离工作区运行，未清理原目录 overlay。

| 检查 | 结果 |
| --- | --- |
| `npm run test:commercial` | 234 文件通过、1 文件跳过；2941 测试通过、18 跳过。含同目录双对话并行和取消不串扰。 |
| `npm run base:test` | 134 文件通过、1 文件跳过；1625 测试通过、18 跳过。 |
| `npm run test:scripts` | 335/335 通过。 |
| 前端文件/预览/桥回归 | 22 文件、284 测试通过。 |
| 前端 `npm run test:conversation` | 117 文件、1206 测试通过。 |
| 前端 `npm run lint:arch` | 通过；3062 模块、13338 依赖，沿用 97 项既有豁免。 |
| ego-browser 页面回归 | runtime/v2 的正常完成、会话续接、分组工具轨迹、渲染展示共 4 场景通过；完整回放、终态收敛、无遗留执行工具，页面记录零错误。 |
| 商业 main/preload production 与 renderer 构建 | 通过；仅保留 renderer 大 chunk 提示。 |
| Electron 40.8.2 本机文件 fixture | 16 项通过：真实 registry/preload/IPC、媒体 Range/seek、100MiB 以上 ZIP、HTML 相对资源与导航隔离、授权撤销等。 |
| Electron CUA 浮窗 fixture | 通过：真实 preload/IPC、登录恢复门禁、外来 sender 拒绝、安全渲染、关闭急停和清理。 |
| overlay 一致性、纯净守卫、桥快照、特性边界、基座兼容、diff 空白检查 | 通过。 |

日志前缀：`/tmp/nuwax-codex-merge-*-20261014.log`。隔离工作区 `.cache/acceptance/local-files-electron.json` 和 `.cache/acceptance/20261014-frontend-mock-e2e.json` 保存本机文件及页面结果。原目录已有脏文件摘要保存于 `/tmp/nuwax-codex-merge-original-workspace-20261014.json`，用于合并后核对。

本次不重跑签名/公证/真实模型账号或其他操作系统的安装包验收；既有验收证据不等同此次组合后的安装包验收。
