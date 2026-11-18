# 引擎隔离 home：`.codex` → `.nuwax-harness`（方案）

日期：2026-11-18
状态：待评审（本文只出方案，未改代码）

## 1. 背景与结论

nuwax-file-server 1.6.4（`bc630c5 干掉codex，加入nuwax-harness`）已把**工作区级**
agent 目录 `.codex` 全量替换为 `.nuwax-harness`（`src/` 内已无 `.codex` 引用）。
但智能体自报的"系统技能根"仍是：

```
/Users/soddy/.nuwax-dev/run/projects/6/<session>/codex-cli/home/.codex/skills/.system
```

这是**引擎隔离 home**（`CODEX_HOME`），与 file-server 改的工作区目录属不同层，由
**客户端**拼接，所以 file-server 升级不会影响它。

目标：把引擎隔离 home 的目录名也改为 `.nuwax-harness`，并且**不丢已有会话数据**
（本地测试依赖旧会话继续可恢复、可验证）。

## 2. 影响面（代码定位）

全仓 grep `.codex`（排除 node_modules / dist / 注释）后，生产代码只有 **2 处**：

| 位置 | 语境 | 处理 |
|---|---|---|
| `src/main/services/engines/acp/acpClient.ts:1058` | ACP 路径（**当前实际使用**）：`is codex-cli` 分支里 `path.join(isolatedHome, ".codex")`，注入 `CODEX_HOME` + `CODEX_SQLITE_HOME` | 改为调用统一解析函数 |
| `src/main/services/engines/engineManager.ts:417` | 旧的非 ACP `createIsolatedEnvironment()`，同样两行注入 | 同上（同一函数） |
| `src/main/services/engines/engineManager.test.ts:106` | 断言 `CODEX_HOME === HOME/.codex` | 更新断言 |
| `acpClient.ts:1052-1056` | 解释 Windows 必须显式隔离的注释 | 同步改文案 |

不受影响（已确认）：

- `CODEX_LOG_DIR`：客户端日志目录，与本 home 无关
- `isolatedHomePaths.ts` 的保留/清理策略：按目录名白名单（`.cache`/`.npm`/`tmp`…），不含 `.codex`
- 会话列表/恢复：走平台 DB + app-server API，不靠 home 目录名
- 引擎侧默认 home（`CODEX_HOME` 未设置时的 `~/.codex`）：客户端始终显式注入，本次不动
- `config` crate 的 `PROJECT_CONFIG_DIR_NAME_COMPAT = ".codex"`（**项目**里的 `./.codex` 配置目录）：保持不动，属另一概念

## 3. 数据现状（为什么迁移成本低）

单个项目隔离 home 实测（1755386，7.5 MB）：

```
home/
├── .bash_profile / .bashrc        # 与引擎无关，不动
├── .claude/                       # claude 引擎配置
├── .codex/                        # ← 本次要改名
│   ├── config.toml                # 用户级配置
│   ├── installation_id
│   ├── sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl   # 会话正文（可扫描发现）
│   ├── session_index.jsonl        # 只有 id / thread_name / updated_at（无绝对路径）
│   ├── skills/  skills/.system/   # 系统技能
│   ├── shell_snapshots/ thread-writer-locks/ tmp/
│   └── *.sqlite(+wal/shm)         # state/queue/logs/memories/goals/thread_history
└── tmp/
```

关键结论（决定迁移可行性）：

1. **`session_index.jsonl` 不含绝对路径**，只有 id 与标题；
2. 引擎按目录扫描 `$CODEX_HOME/sessions/**` 发现 rollout，**不依赖库里存的绝对路径**；
3. 各 `*.sqlite` 仅 `logs_2.sqlite` 内含绝对路径（11 处），是日志文本，不影响功能；
4. rollout jsonl 里出现的旧绝对路径是**历史对话文本**（当时提示词里带了技能路径），不参与查找。

→ 整目录 rename 后引擎可正常按新路径扫描到旧会话，无需改写任何数据内容。

## 4. 方案设计

### 4.1 单点解析 + 一次性迁移

新增 `resolveEngineHome(isolatedHome: string): string`（放 `src/main/services/engines/acp/isolatedHomePaths.ts`，
两处调用都 import 它，避免再次漂移）：

```ts
export const ENGINE_HOME_DIR_NAME = ".nuwax-harness";
export const LEGACY_ENGINE_HOME_DIR_NAME = ".codex";

export function resolveEngineHome(isolatedHome: string): string {
  const next = path.join(isolatedHome, ENGINE_HOME_DIR_NAME);
  const legacy = path.join(isolatedHome, LEGACY_ENGINE_HOME_DIR_NAME);
  migrateLegacyEngineHome(legacy, next);   // 幂等
  fs.mkdirSync(next, { recursive: true }); // 引擎只校验存在性，不自建
  return next;
}
```

### 4.2 迁移规则（幂等、可回滚、绝不静默丢数据）

`migrateLegacyEngineHome(legacy, next)`：

| 状态 | 动作 |
|---|---|
| 旧不存在 | 直接返回（新目录由调用方 mkdir） |
| 旧存在、新不存在 | `fs.renameSync(legacy, next)` —— 同盘原子；随后写 `.migrated-from-codex.json`（时间戳 + 版本） |
| 都存在 | 逐项合并：把旧目录里**新目录没有的**条目 `rename` 进新目录；同名冲突保留新目录那份，把旧的那份改名为 `<name>.from-codex-<ts>` 保留；最后把旧目录整体改名为 `.codex.migrated-<ts>` |
| `rename` 失败（EXDEV / EBUSY / 权限） | **回退到旧目录**：`log.error` + 返回 `legacy`，引擎继续用 `.codex` 正常跑；绝不新建空目录顶替 |

要点：

- **永不删除**旧数据，只改名。回滚 = 把 `.codex.migrated-*` 改回 `.codex`。
- 迁移发生在 **spawn 引擎之前**（`acpClient` 构造 env 时），此时引擎未运行，不存在 sqlite 句柄占用。
- 每个项目/会话的隔离 home 各自独立，迁移按需触发；老项目下次打开时才迁移，无需全局脚本。
- 加开关 `NUWAX_ENGINE_HOME_LEGACY=1` 强制继续用 `.codex`（应急用，默认不设）。

### 4.3 迁移标记

`<home>/.nuwax-harness/.migration.json`：

```json
{"from": ".codex", "at": "2026-11-18T10:30:00Z", "appVersion": "3.2.0-beta.6", "mode": "rename|merge"}
```

便于支持侧判断某个用户是否已迁移、以及合并过哪些条目。

## 5. 兼容与回滚

- **向前兼容**：新客户端读到旧目录会自动迁移；旧客户端读新目录会找不到会话 →
  发布说明里注明"降级前请把 `.nuwax-harness` 改回 `.codex`"。
- **回滚窗口**：保留 `.codex.migrated-<ts>` 至少一个版本周期；`docs` 里写清手工回滚命令。
- **不影响** file-server 1.6.4 的工作区目录改动（两层互不依赖）。

## 6. 测试计划

单元（vitest，tmp 目录）：

1. 只有旧目录 → 迁移后新目录存在、旧目录消失、`sessions/` 内容一致
2. 只有新目录 → 不动
3. 两者都没有 → 创建新目录
4. 两者都有且内容重叠 → 冲突条目保留新+旧改名，非冲突条目合并
5. `rename` 抛 EXDEV/EBUSY（mock）→ 返回旧目录、不创建空的新目录、日志有 error

手工（本地，现有项目 1755386）：

1. 启动客户端 → 确认 `home/.nuwax-harness/` 出现、`home/.codex.migrated-*` 存在
2. 让智能体自报系统技能根 → 应为 `.../home/.nuwax-harness/skills/.system`
3. **恢复旧会话**：打开迁移前的会话继续对话，验证 rollout 可读、上下文连续
4. `config.toml`（含 provider 配置）仍生效；`state/queue/thread_history` 无损坏告警
5. 新建一个项目（无旧目录）→ 直接生成 `.nuwax-harness`

## 7. 文档更新

- `docs/`（本文）
- 客户端发布说明：目录变更 + 自动迁移 + 降级注意
- `NUWAX-HARNESS.md`（引擎仓库）：`CODEX_HOME` 的推荐值改为 `.nuwax-harness`，
  注明"引擎默认 `~/.codex` 不变，由宿主注入"

## 8. 工作量与风险

| 项 | 估计 |
|---|---|
| 代码改动 | 2 处调用 + 1 个新函数（约 80 行）+ 测试 |
| 风险 | 低：无 schema 变更、无数据改写；失败时回退旧目录 |
| 主要风险点 | Windows 上 `.codex` 若被其他进程占用导致 rename 失败 → 走回退分支，功能不受影响 |

## 9. 待确认

1. 目录名确认为 `.nuwax-harness`（与 file-server 工作区目录同名，同一产品语义）？
2. `.codex.migrated-<ts>` 保留多久（建议 1 个版本周期后由清理策略回收）？
3. 是否需要同时在引擎侧把默认 home 从 `~/.codex` 改掉（影响面大，建议单独排期）？
