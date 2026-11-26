# 实施计划：session-setup-ha（会话建立阶段高可用）

- 对应 spec：specs/session-setup-ha.md
- 状态：实施中

## 背景

2026-11-25 同事会话 1759004 发不出消息：引擎在该会话的目录级初始化处永久卡死，`session/load` 与回退的 `session/new` 都不返回，`/computer/chat` 一直挂到后端超时（约 4 分钟），前端只看到 `java.net.http.HttpTimeoutException`。同机同时段新建会话正常。

读码确认的成因：

- 只有 `session/load` 有超时（15 秒），且只是外部计时、不取消 RPC。回退的 `session/new`、`session/set_config_option`、`initialize`、插件共享的 `npm install` 都没有超时。
- 超时后引擎进程不被处理，后续每条消息都在同一条可能已卡死的连接上再发一组 load/new。
- 建立失败没有摘要日志；引擎自己的日志不在日志目录（1.17.11 不读 `OPENCODE_LOG_DIR`），也不在导出包里。
- home 清理按 `home` 目录自身 mtime 判陈旧，仍在使用的会话数据可能被误删；空闲驱逐的活跃时间戳在快速路径上不刷新。

## 目标

任何会话建立失败都在有界时间内得到明确结果；能自愈的自愈；不能自愈的给出可操作的错误和诊断。

## 待确认的边界

- 恢复策略默认「优先保上下文」：15 秒只告警并继续等，40 秒硬上限才放弃恢复。
- 自愈力度默认「自动隔离引擎 home 并重建」，受规格里的安全约束，可用 `SESSION_SETUP_AUTO_QUARANTINE` 关闭。
- 预算是初值，上线后用 `[SessionSetup]` 摘要日志校准。
- 后端调用 `/computer/chat` 的超时值待确认（现观测不少于约 3.5 分钟），建议不少于 180 秒。

## 改动文件清单

路径前缀 `SHELL` = `nuwa-electron-shell/crates/agent-electron-client/src`。

| # | 文件 | 动作 | 说明 |
|---|---|---|---|
| 1 | `SHELL/main/services/engines/acp/acpSetupBudgets.ts` | 增 | 预算常量、软/硬超时包装、超时错误类型；`NUWAX_ACP_SETUP_BUDGETS` 覆盖 |
| 2 | `SHELL/main/services/engines/acp/acpSessionRecovery.ts` | 增 | 恢复链路状态机、判定、黑名单、熔断；隔离留接口 |
| 3 | `SHELL/main/services/engines/acp/acpSessionSetup.ts` | 改 | 去掉只在 load 外层计时的旧包装，供链路复用 |
| 4 | `SHELL/main/services/engines/acp/acpEngine.ts` | 改 | 握手超时；`destroy()` 只取消本引擎审批、重置登记标志；代际校验；`recycleForRecovery()`；`chat()` 接入链路、摘要、响应字段 |
| 5 | `SHELL/main/services/engines/acp/acpClient.ts`、`opencodePluginShare.ts` | 改 | spawn 等待与 `npm install` 加超时并杀进程 |
| 6 | `SHELL/main/services/computer/router.ts` | 改 | 传入链路起点时间；熔断期内直接返回；错误信封不变 |
| 7 | `SHELL/main/services/engines/acp/sessionSetupFailure.ts` | 增 | 失败信封构造与判定到文案的映射 |
| 8 | `SHELL/shared/locales/*.json` | 改 | 四个语言文件补三条错误文案 |
| 9 | `SHELL/main/services/engines/acp/isolatedHomePaths.ts` | 改 | 隔离函数；陈旧判定取最新文件 mtime；`opencode/log` 按文件时间保留；隔离目录 7 天回收 |
| 10 | `SHELL/main/services/engines/acp/opencodeSessionDiagnostics.ts`、`sessionSetupDiagnostics.ts` | 改/增 | 引擎日志尾部读取；建立结果环形缓冲 |
| 11 | `SHELL/main/services/utils/logArchive.ts`、`SHELL/main/ipc/logExportHandler.ts`、`SHELL/main/services/engines/sessionSetupArchiveExtras.ts` | 改/增 | 导出追加引擎日志尾部与诊断 JSON |
| 12 | `SHELL/main/services/engines/unifiedAgent.ts` | 改 | 活跃时间戳在快速路径与 prompt 结束时刷新；注入活跃 home 列表 |
| 13 | 各对应 `*.test.ts` | 改/增 | 见下 |
| 14 | `tests/manual/session-setup-ha/` | 增 | 对随包真实引擎二进制的复现脚本（Node）与端到端验收步骤 |

## 实施顺序

分三个可独立合并的阶段，按顺序做。

1. **P0 止血**：#1–#8 与对应测试。任何建会话 RPC 无响应都在预算内结束；硬超时后重建进程；失败返回结构化错误；熔断与并发共享。
2. **P1 自愈与诊断**：#9–#11，并把隔离接入 #2。隔离 home 后重试；摘要日志、引擎日志尾部、导出包。
3. **P2 收尾**：#12、#14，ACP 载荷日志脱敏与降级，修正 `OPENCODE_LOG_DIR` 的误导性注释。

## 证明成立的测试

- 验证方式：
  - `acpSessionRecovery.test.ts`、`acpSessionSetup.test.ts`（假计时器）：慢恢复后成功保留上下文；load 报错回退；load 硬超时后重建成功；新进程仍超时；链路时限；黑名单；熔断；并发共享。
  - `acpEngine.test.ts`：`destroy()` 不取消其他引擎的审批；重建后旧续体不登记会话；握手超时返回失败且进程被杀；模型同步超时。
  - `isolatedHomePaths.test.ts`：隔离函数三种结果；陈旧判定三种；日志与隔离目录回收。
  - `router.chatDispatch.test.ts`、`logArchive.test.ts`、`logExportHandler.test.ts`：熔断期返回与导出内容。
  - 手动：macOS 开发环境放永不返回的 `.opencode/plugins/hang.js` 复现卡死；Windows 安装包同步骤验收进程树 kill 与目录改名。
- 回归范围：改动涉及的测试文件定向运行；`npm run typecheck`；合并前 `npm run test:commercial`。

## 风险与回退

| 风险 | 缓解 | 回退方式 |
|---|---|---|
| 40 秒仍不够的健康机器被误杀 | 预算可用环境变量调；隔离前有「新进程再试一次」双确认；摘要日志供校准 | 调大预算 |
| 误隔离丢上下文 | 原 home 改名保留 7 天；共用 home 或机器级变慢时不隔离 | 关 `SESSION_SETUP_AUTO_QUARANTINE`，降为快速失败 |
| 重建时波及其他会话 | P0 先把 `destroy()` 的审批取消收敛到本引擎并加单测 | 无 |
| 链路时长贴近后端超时 | 150 秒总时限；上线前确认后端值 | 调小 `chainDeadlineMs` |
| Windows 改名被文件占用 | 归入 `quarantine_failed`，不重试 | 无 |

## 偏离记录

（实现中偏离本计划的逐条补记：原因 + 对应提交）
