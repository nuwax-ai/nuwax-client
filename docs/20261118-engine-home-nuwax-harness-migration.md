# 引擎隔离 home 与引擎标识：统一到 `nuwax-harness`（方案 v2）

日期：2026-11-18
状态：待评审(只出方案,未改代码)
变更点：v1 假设“引擎侧默认 home 仍是 `~/.codex`”**有误**；本版据实修正，并按
“`codex`/`codex-cli` 从未正式启用、真实用户只用 `claude-code-acp-ts` / `nuwaxcode`”
这一前提重排。

## 0. 先纠正两个事实（v1 的前提错误）

**事实一：引擎侧默认 home 早就是 `~/.nuwax-harness`。**
`codex-rs/utils/home-dir/src/nuwax_default.rs:18`

```rust
let nuwax_home = user_home.join(".nuwax-harness");
```

即 `CODEX_HOME`/`NUWAX_HOME` 未设置时，引擎已经落在 `~/.nuwax-harness`。所以
“引擎侧默认 home 要不要改”这件事**已经完成**，不需要动。残留在 `tui/` 的
`.codex` 除 `external_editor.rs:185` 外均为测试代码，那一处是“外部编辑器临时文件
的可写目录候选”（`codex_home` 已是第一候选），非默认 home 语义。

**事实二：客户端路径里有**两段**需要改，而不是一段。**

```
~/.nuwax-dev/run/projects/{userId}/{workDirId}/{engine}/home/{CODEX_HOME}
                                                ^^^^^^^^        ^^^^^^^^^^^
                                                ①引擎段         ②引擎 home 目录名
```

实测：`~/.nuwax-dev/run/projects/6/1755386/codex-cli/home/.codex`

- ① `{engine}` 段来自 `scope.engine`（`isolatedHomePaths.ts` → `sanitizePathSegment(scope.engine)`）
- ② `.codex` 来自 `path.join(isolatedHome, ".codex")`（`acpClient.ts:1058` / `engineManager.ts:417`）

只改 ②，路径里仍会看到 `codex-cli`；只改 ①，agent 自报的系统技能根仍是 `.codex`。
两段都要处理，且**旧数据要能继续用**（你本地验证依赖旧会话）。

## 1. 命名与 id 的关键决策

| 层 | 现值 | 建议 | 理由 |
|---|---|---|---|
| 平台下发的引擎 id（wire） | `codex-cli`（也接受 `codex`） | **保留 `codex-cli`，同时接受 `nuwax-harness` 作为别名**，内部归一化到同一实现 | id 是平台契约，改 id 要后端同步发版；先加别名，平台切换时客户端无需再改 |
| 磁盘引擎段目录 | `codex-cli` | **`nuwax-harness`** | 用户可见路径，产品语义统一；用映射表与 id 解耦 |
| 引擎 home 目录名 | `.codex` | **`.nuwax-harness`** | 与 file-server 1.6.4 的工作区目录同名 |

解耦做法（关键）：`id → 目录段` 用显式映射，而不是直接把 id 当目录名。

```ts
// isolatedHomePaths.ts
const ENGINE_HOME_SEGMENTS: Record<string, string> = {
  "codex-cli": "nuwax-harness",
  "nuwax-harness": "nuwax-harness",
};
export function engineHomeSegment(engineId: string): string {
  return ENGINE_HOME_SEGMENTS[engineId] ?? sanitizePathSegment(engineId);
}
```

这样：平台继续发 `codex-cli` 也能落到 `.../nuwax-harness/home/`；将来平台改发
`nuwax-harness` 也命中同一目录，无需迁移第二次。

## 2. 数据迁移设计（两步，幂等、绝不丢数据）

两个迁移都在 **spawn 引擎之前**执行（无 sqlite 句柄占用，Windows 亦安全），且都遵循
同一套策略。

### 2.1 公共策略：`migrateDirectory(legacy, target)`

| 状态 | 动作 |
|---|---|
| legacy 不存在 | 直接返回 target（调用方 mkdir） |
| legacy 存在、target 不存在 | `fs.renameSync`（同盘原子）+ 写迁移标记 |
| 都存在 | 逐项合并：target 缺失的条目从 legacy `rename` 进来；同名冲突保留 target 的那份，legacy 那份改名为 `<name>.from-legacy-<ts>`；最后把 legacy 整体改名为 `<legacy>.migrated-<ts>` |
| rename 失败（EXDEV/EBUSY/EPERM） | **回退使用 legacy**，`log.error` 记录；绝不创建空 target 顶替 |

保留期：`<legacy>.migrated-<ts>` 保留 **1 个版本周期**（你已确认），之后由既有清理策略回收。

### 2.2 迁移一：引擎段目录

`run/projects/{user}/{workDirId}/codex-cli` → `run/projects/{user}/{workDirId}/nuwax-harness`

触发点：`resolveProjectIsolatedHomeDir()` 计算引擎段时（对 `codex-cli` 映射到
`nuwax-harness` 的场景执行一次）。

### 2.3 迁移二：home 内部目录名

`<home>/.codex` → `<home>/.nuwax-harness`

触发点：新增 `resolveEngineHome(isolatedHome)`（放 `isolatedHomePaths.ts`），
`acpClient.ts` 与 `engineManager.ts` 都改调它。

标记文件：`<home>/.nuwax-harness/.migration.json`

```json
{"from": ".codex", "at": "2026-11-18T10:30:00Z", "appVersion": "3.2.0-beta.x", "mode": "rename"}
```

### 2.4 为什么迁移是安全的（已实测核对）

| 检查 | 结果 |
|---|---|
| `session_index.jsonl` | 仅 `id/thread_name/updated_at`，**无绝对路径** |
| 会话发现方式 | 扫描 `$CODEX_HOME/sessions/**/*.jsonl`，不依赖库内路径 |
| `*.sqlite` | 只有 `logs_2.sqlite` 含绝对路径（11 处，纯日志文本） |
| rollout jsonl 内旧路径 | 是历史对话正文，不参与查找 |

→ 整目录改名后旧会话仍可发现与恢复，无需改写任何数据。

## 3. 客户端代码改动清单

| 文件 | 改动 |
|---|---|
| `services/engines/types.ts:8` | 联合类型加 `"nuwax-harness"`（保留 `codex-cli` 兼容） |
| `ipc/agentHandlers.ts:14,64-66` | zod enum 加 `nuwax-harness`；normalize 里把 `codex`/`codex-cli`/`nuwax-harness` 统一 |
| `services/engines/agentHelpers.ts:12,17` | 命令名 → 引擎 id 的映射加 `nuwax-harness` |
| `services/engines/engineManager.ts:31,116,159,231,266,411` | 类型联合与 `codex-cli` 判定分支改为“是否 harness 家族” |
| `services/engines/engineManager.ts:417` | 改用 `resolveEngineHome(isolatedHome)` |
| `services/engines/acp/acpClient.ts:1052-1058` | 同上；注释同步（含 Windows 隔离说明） |
| `services/engines/acp/isolatedHomePaths.ts` | 新增 `engineHomeSegment()`、`resolveEngineHome()`、`migrateDirectory()` |
| `services/engines/acp/config/engineProfile.ts:4` | `OPENCODE_ENGINE_IDS` 加 `nuwax-harness`（保持现有行为不变） |
| `services/agentInstaller.ts:60` | 安装器引擎列表加 `nuwax-harness` |
| `services/system/processRegistry.ts:14` | engineType 联合加 `nuwax-harness` |
| `services/engines/engineManager.test.ts:106` | 断言改为 `.nuwax-harness` |

不改动：

- `CODEX_LOG_DIR`（独立日志目录）
- `isolatedHomePaths.ts` 的缓存/保留白名单（`.cache`/`.npm`/`tmp`）
- 引擎 `config` crate 的 `PROJECT_CONFIG_DIR_NAME_COMPAT = ".codex"`（项目级配置目录，另一概念）

## 4. 引擎侧改动

- **无需改默认 home**（已是 `~/.nuwax-harness`）
- 可选清理一处：`tui/src/external_editor.rs:185` 的
  `dirs::home_dir().map(|home| home.join(".codex"))` 候选改为 `.nuwax-harness`
  （行为不变，仅去掉旧目录候选）
- `CODEX_HOME` / `NUWAX_HOME` 双别名读取保持不变（`env_alias::resolve_env_alias`）

## 5. 测试计划

单元（vitest + tmp 目录）：

1. 引擎段迁移：仅旧段存在 → 改名为新段；两段都存在 → 合并、旧段留 `.migrated-*`
2. home 迁移：仅 `.codex` → `.nuwax-harness`；两者都有 → 合并；都不存在 → 新建
3. `rename` 抛 EXDEV/EBUSY → 回退旧路径、不创建空目录、有 error 日志
4. id 归一：`codex` / `codex-cli` / `nuwax-harness` 三种输入映射到同一目录段
5. `engineManager.test.ts` 的 `CODEX_HOME` 断言更新后通过

手工（用现有项目 1755386）：

1. 启动后 `run/projects/6/1755386/` 下出现 `nuwax-harness/home/.nuwax-harness/`
2. agent 自报系统技能根 = `.../home/.nuwax-harness/skills/.system`
3. **打开迁移前的旧会话继续对话**（关键验收点：rollout 可读、上下文连续、工具可用）
4. `config.toml`、`installation_id`、`*.sqlite` 均随目录迁移且无损坏告警
5. 新建项目（无旧目录）→ 直接生成新结构
6. 回滚演练：把 `nuwax-harness` 段与 `.nuwax-harness` 改回旧名，客户端仍可用（证明可回退）

## 6. 工作量与风险

| 项 | 估计 |
|---|---|
| 客户端改动 | 约 11 个文件（多数是一行枚举/映射）+ 1 个迁移工具模块（约 100 行）+ 测试 |
| 引擎改动 | 0（可选 1 行） |
| 风险 | 低。无 schema 变更、无数据改写；rename 失败回退旧目录 |
| 主要风险 | ① Windows 上旧目录被占用 → 走回退分支，功能不受影响 ② 平台若已把 `codex-cli` 写进 agent 配置，别名兼容可覆盖 |

## 7. 待确认（3 项）

1. **wire id**：保留 `codex-cli` + 接受 `nuwax-harness` 别名（推荐，不需后端改动），
   还是直接让平台改发 `nuwax-harness`？
2. **磁盘引擎段**：确认用 `nuwax-harness`（本方案默认），旧 `codex-cli` 段自动迁移。
3. `.codex.migrated-<ts>` / `codex-cli.migrated-<ts>` 保留 1 个版本周期后由清理策略回收
   —— 确认是否要在清理策略里显式加这条（否则会一直留着）。
