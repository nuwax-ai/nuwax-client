# 实施计划：client-auto-update-check

- 对应 spec：`specs/client-auto-update-check.md`
- 状态：已完成（2026-09-23；未运行测试，待关于页安装包验收）

## 改动文件清单

| # | 文件 | 动作(增/改/删) | 说明 |
|---|---|---|---|
| 1 | `nuwa-electron-shell/crates/agent-electron-client/src/main/services/autoUpdater.ts` | 改 | 启动首查从 10 秒缩短为 1 秒 |
| 2 | `nuwa-electron-shell/crates/agent-electron-client/src/main/services/autoUpdater.test.ts` | 改 | 更新现有首查定时断言，不新增用例 |
| 3 | `nuwa-electron-shell/crates/agent-electron-client/src/main/services/autoUpdater.ts` | 改 | 支持静默检查并抑制检查过程中的状态事件 |
| 4 | `nuwa-electron-shell/crates/agent-electron-client/src/main/ipc/appHandlers.ts` | 改 | 将后台检查选项传入更新服务 |
| 5 | `overlay/crates/agent-electron-client/src/preload/index.ts` | 改 | 将后台检查选项传过 IPC |
| 6 | `overlay/crates/agent-electron-client/src/shared/types/electron.d.ts` | 改 | 声明可选检查选项 |
| 7 | `nuwa-electron-shell/crates/agent-electron-client/src/renderer/components/pages/AboutPage.tsx` | 改 | 每次挂载静默检查并读取最终状态 |

## 实施顺序

1. 调整首查延迟和已有调度用例断言。
2. 从 AboutPage 挂载触发后台检查，并保证中间事件不改变页面状态。
3. 通过 IPC/preload 传递后台检查选项，更新完成后读取权威状态。
4. 检查差异与现有最新通道指针/平台清单发布契约。

## 证明成立的测试

- 已有调度用例规定首查在 1 秒时触发、之后继续按既有周期复检，并在退出时停止调度。
- 按本轮执行约束，不运行测试；About 页多次进入、静默失败和手动检查行为留待后续验收。

## 风险与回退

| 风险 | 缓解 | 回退方式 |
|---|---|---|
| 首查提前可能与启动工作并行 | 保留 1 秒短缓冲；检查本身为后台静默操作 | 恢复 10 秒首查常量及对应断言 |

## 偏离记录

- “直达当前通道最新版本”已由现有 `latest.json` 指针和对应版本 yml 实现，本次不重复改写发布/下载逻辑。
