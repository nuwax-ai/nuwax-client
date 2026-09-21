# 计划：基座补 `nuwax-codex-acp-ts` 引擎别名 + 双产品重新打包发 beta

日期：2026-09-20 · 分支：壳 `main` / 外层 `release/v1.0.x` / nuwaclaw `feature/electron-client-0.14`（基座 `community/main`）

## 背景与根因

win 真机个人电脑会话（project 1693869/1693870）发消息即报 `Failed to create engine: ACP connection closed`。根因链：后端下发 `agent_server.command = "nuwax-codex-acp-ts"`（Codex TS adapter 包名），壳 `mapAgentCommand`（agentHelpers.ts:7）codex 家族别名表只有 `codex-cli/codex-acp/nuwax-codex-acp`，不认 `-ts` 后缀新名 → 走 fallbackEngine（claude-code）+ 原命令作 customEngineCommand → `resolveAcpBinary` 的 codex 适配器分支（仅 `codex|codex-cli` 可达）进不去 → 自定义 agent 分支 PATH 裸 spawn → `spawn nuwax-codex-acp-ts ENOENT`。证据：~/Downloads/latest(4).log 141352/141397/141401 行。

## 改动点（壳基座，一行修复 + 测试）

1. `crates/agent-electron-client/src/main/services/engines/agentHelpers.ts` — codex 家族别名加 `"nuwax-codex-acp-ts"` → `"codex-cli"`（claude 侧 `"claude-code-acp-ts"` 已有同形先例）。
2. `agentHelpers.test.ts` 补映射用例。

不改 `resolveAcpBinary`（codex 分支已能经 bundled adapter 解析，CI `prepare:all`→`prepare:codex-acp-ts` 保证 resources 进包）。

## 门禁

- 壳内：vitest 跑 engines 相关用例。
- 外层：`node scripts/sync-overlay.js` 后 `npx vitest run`（商业门禁；base:test 会清 overlay 不在本轮）。

## 落位与发版（双产品）

| 步骤 | 仓/分支 | 动作 |
| --- | --- | --- |
| 1 | 壳 `main` | 提交修复（显式 add 两个源文件，排除 icon 等 overlay 同步产物），push origin/main |
| 2 | nuwax-client `release/v1.0.x` | bump 壳 pin，提交 push；`release-notes/prerelease-v1.0.20.md`；tag `prerelease-v1.0.20` → beta CI（五矩阵 ~1.5h） |
| 3 | nuwaclaw 壺检出 `community/main` | fetch 后 cherry-pick 同一修复提交，push |
| 4 | nuwaclaw `feature/electron-client-0.14` | bump 基座 pin，提交 push；`release-notes/prerelease-v0.14.3.md`；tag `prerelease-v0.14.3` → 社区 CI |

## 风险与边界

- 外层工作树有用户在途 overlay WIP（commercialAuth/nuwaxBridgeHandlers/TrafficLightToolbar）与 docs 未跟踪件：不碰、不进提交。
- 壳工作树 icon/migrate.commercial.test.ts 脏文件是 overlay 同步产物：不 add、不还原。
- 用户机已装的 v1.0.18/19 不含映射修复，升级到 v1.0.20 后生效；v1.0.20 包内必含适配器（prepare 链已核）。
- 社区线 @fcf1d632 已有 codex 分支与 adapter 依赖，cherry-pick 可干净落地。
