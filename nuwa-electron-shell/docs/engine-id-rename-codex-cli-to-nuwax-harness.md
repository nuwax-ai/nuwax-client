# 方案记录：引擎标识 `codex-cli` → `nuwax-harness`

> 状态：**提案，未开工**（2026-11-13 记录，待决策）
> 关联：[nuwax-harness.md](nuwax-harness.md)

## 背景

客户端内部把 Nuwax Harness 引擎标识为 `codex-cli`。命令侧其实早就是新名字——
`agentHelpers.ts::mapAgentCommand` 与 `agentInstaller.ts::BUILTIN_AGENTS` 都把
`nuwax-harness` / `nuwax-harness-acp-ts` 归一成 `codex-cli`：

```ts
if (command === "codex-cli" || command === "codex" ||
    command === "nuwax-harness" || command === "nuwax-harness-acp-ts") {
  return "codex-cli";
}
```

残留影响两处可见位置：

1. 隔离 HOME 路径 `~/.nuwax-dev/run/projects/<userId>/<workDirId>/codex-cli/home/.codex/`
   （单项目已有 600 MB 级会话与 sqlite），用户看到 `codex-cli` 会误以为装的是上游 Codex；
2. 引擎选择、安装检测、进程注册表里的类型字符串。

与 fork 既有的品牌清理方向（`codex_apps`→`nuwax_apps`、TUI 命令与文案）一致。

## 决策要点

**不做**：新增第 4 个类型与 `codex-cli` 并存。两套类型指向同一二进制，会让 26+ 处
`engine === "codex-cli"` 判断退化成"两个值都算"，只是把分裂固化。

**要做（若采纳）**：把类型标识正名为 `nuwax-harness`，旧值在**边界处**别名归一——
读旧值、写新值。

## 改动清单

| # | 位置 | 改法 |
|---|---|---|
| 1 | `src/main/services/engines/types.ts`、`engineManager.ts`、`src/shared/types/electron.d.ts`、`processRegistry.ts` | 类型联合改为 `"nuwax-harness"` |
| 2 | `src/shared/constants.ts` | `SUPPORTED_AGENT_ENGINES` 用新值；新增 legacy 别名表（`codex`、`codex-cli`、`nuwax-harness-acp-ts` → `nuwax-harness`），`normalizeAgentEngine` 读旧写新 |
| 3 | `src/main/ipc/agentHandlers.ts` | 过渡期 zod enum 同时接受新旧值 |
| 4 | `engineManager.ts`(5 处)、`acpEngine.ts`、`acpClient.ts`、`openAICompatRouting.ts`、`acp/config/engineProfile.ts` | 抽 `isHarnessEngine(engine)` 收口，避免继续散落字符串比较 |
| 5 | `src/main/services/engines/acp/isolatedHomePaths.ts` | 路径段自然变为 `nuwax-harness`，**必须配迁移**（见下） |
| 6 | 引擎选择项、设置页文案 | 展示名统一 |

## 迁移与兼容（风险集中点）

- **隔离 HOME**：首次解析到新路径时，若 `codex-cli/home` 存在而 `nuwax-harness/home`
  不存在 → `fs.renameSync` 原子迁移（同盘秒级）；目标已存在则跳过，不覆盖。
- **后端下发**：`agent_server.command` 可能是 `codex` / `codex-cli`，由别名表兜住。
- **本地已存设置**：`normalizeAgentEngine` 兜住；写回时使用新值。
- **不做双写**：不保留"两套目录同时存在"的兼容层，迁移一次即可。

## 建议的落地顺序

1. **第一步（低风险）**：先只改路径段显示名（`isolatedHomePaths.ts` 显示名映射 + 自动迁移），
   用户立刻看到 `nuwax-harness/`，类型标识不动，不触碰 IPC 与后端契约。
2. **第二步**：类型标识正名 + 别名表 + 收口 26 处比较，等一个回归窗口做。

## 未决问题

- 是否接受一次性目录改名（`renameSync` 失败时回退为软链）？
- 后端/会话列表里是否还有按 `codex-cli` 字符串过滤的逻辑（需全仓检索确认）？
- `DEFAULT_AI_ENGINE` 目前是 `claude-code`，与本提案无关，是否单独讨论？
