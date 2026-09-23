# 分支命名规范（三仓）

> **适用范围**：外层仓 `nuwax-client` 与基座 submodule `nuwa-electron-shell` 的分支创建与生命周期；前端 submodule `nuwax` 为外部协作仓，本文只约束我方消费行为（§4）。
> **事实源声明**：本文件是分支命名的权威规范；README「分支模型与双轨门禁」一节仅保留摘要并指向此处。规范定档日：2026-09-15。

## 1. 总则

- 语法：`<type>/<slug>`，全小写，slug 用连字符 `-` 分词；禁用空格、下划线、中文、大写字母。
- slug 描述「做什么」，不描述「谁在做」：`feat/webview-keep-alive` ✅，`feat/dong-0930` ❌（人名线只在前端仓按对方惯例使用，见 §4）。
- 一个分支一个意图；多主题混合的改动拆成多个分支。
- type 词表收口如下，不再新增同义词（`bugfix` 并入 `fix`，`hotfix` 并入 `fix`）：

| type | 用途 | 示例 |
|---|---|---|
| `feat` | 新功能、含行为变更的改动 | `feat/agent-work-dir-absolute` |
| `fix` | 缺陷修复 | `fix/gethostname-handler` |
| `refactor` | 不改行为的等价重构 | `refactor/qa-optimization-0912` |
| `chore` | 构建 / 依赖 / 脚本杂务 | `chore/bump-base-pin` |
| `docs` | 纯文档改动 | `docs/branch-naming` |
| `release` | 版本线，格式固定（§2.3） | `release/v1.0.x` |
| `codex` | agent 自治工作分支（会话隔离用） | `codex/download-redirect-closeout` |
| `archive` | 完结分支的归档去向，冻结不进提交 | `archive/electron-client-1.0-full` |
| `dependabot` | bot 专用前缀，人工不使用 | `dependabot/github_actions/…` |

## 2. 外层仓 nuwax-client

### 2.1 main（主干）

- 唯一集成分支，只经 PR 合入，不直接 push。
- 发布不由 main 驱动，由 tag 驱动（§2.5）。

### 2.2 工作分支（feat / fix / refactor / chore / docs / codex）

- 从 main 切出，PR 回 main；合并即删（§5）。
- ⚠️ **CI 触发是硬约束**：`ci.yml` 的 push 触发**只挂 `main`**（2026-09-17 收窄，对齐 nuwaclaw 基座仓口径；此前曾挂 `feat/**`，工作分支每次 push 都跑 30 分钟全套门禁属纯噪音）。所有工作分支（`feat/*`、`fix/*`、`codex/*` 等）**push 一律不跑 CI**，开 PR 回 main 后由 `pull_request` 跑双轨门禁（全覆盖）。

### 2.3 release/vX.Y.x（版本线）

- 格式固定：`release/v<major>.<minor>.x`，末位 `x` 为字面通配——patch 位由 tag 递进，分支名不随 patch 变化。
- 从 main（或收尾提交）切出；线上只进 cherry-pick 与发布收尾提交（release-notes、pin bump），不进新功能。
- **回流**：对应正式 tag（`electron-vX.Y.Z`）验证转正后，将线 PR 回 main（可 fast-forward），随后删除该线。不回流 = 主干与发布产物长期分叉。
- 现状（定档日）：`release/v1.0.x` 领先 main 19 个提交，基点 `codex/download-redirect-closeout@2043f755`；`electron-v1.0.4` 已转正，待回流。

### 2.4 archive/*

- 完结但需留名的历史线统一挪 `archive/` 前缀；归档分支冻结，不再接受提交。

### 2.5 tag（发布驱动）

| tag 格式 | 触发 workflow | 用途 |
|---|---|---|
| `electron-vX.Y.Z` | `release-electron.yml` | 正式版 |
| `prerelease-vX.Y.Z` | `release-electron-dev.yml` | 预发（验证通过后转正） |

- 预发 → 转正节奏：先打 `prerelease-vX.Y.Z` 走预发链路，验证通过后再打 `electron-vX.Y.Z`，并补 `release-notes/electron-vX.Y.Z.md` 正式说明。
- **重打同号 tag 前必须先删远端 tag 与对应 Draft Release**，否则产物/Release 会错挂。

### 2.6 已知缺口（待办）

- `ci.yml` push 触发不含 `release/**`：版本线上的 push 不跑双轨门禁，需手动执行 `npm run base:test` + `npm run test:commercial`（注意 base:test 会清 overlay，跑完记得 `overlay:sync` 还原）。若版本线活动频繁，可把 `release/**` 加进 push 触发，待拍板。

## 3. 基座仓 nuwa-electron-shell

- **单主干**：`feat/* → PR → main`；外层基座 pin 跟随基座 main（`.gitmodules` branch=main）。
- **产品中立铁律**：分支名与提交内容均不得含 nuwax / 商业专有信息——该仓是多消费方共享的中立基座（nuwax-client、nuwa-cli、社区版）；历史 `pin/nuwawork` 线即因污染商业语义而退役。
- **勿 rebase 已 pin SHA**：基座提交一旦被外层 gitlink 引用，改写等于断 pin；feat 线过时用新提交追赶，不改写历史。
- `dependabot/*` 由 bot 管理，人工不建同前缀分支。

## 4. 前端仓 nuwax（外部协作仓 · 仅消费侧规则）

- 该仓默认主干为 `dev`，分支规范归对方团队；我方**不定义**其命名规范。
- 当前消费线按用户指定为 `feat-2026.9.30`；前端仓分支规范归对方团队，勿擅自改成 `feat/` 斜杠格式。
- **硬约束**：外层 bump `nuwax/` gitlink 时，被引提交必须位于 `.gitmodules` 声明分支（当前 `feat-2026.9.30`）上可达，否则 release/smoke 流程的 submodule 拉取失败。实证口径：gitlink 只须在声明分支可达，不须在默认分支。
- 遗留 `pin/nuwawork` / `pin/nuwa-work` 为改名遗留分支：保留勿动、勿快进（历史 gitlink 的可达性保险）。

## 5. 生命周期与清理

| 阶段 | 规则 |
|---|---|
| 工作分支合入 main | 合并即删：删远端与本地分支，不留墓碑 |
| 版本线 | 正式 tag 转正 + 回流 main 后删除 |
| 有考古价值的完结线 | 挪 `archive/<slug>` 归档，冻结 |
| 长期挂着的本地实验分支 | 定期清理；不推远端的不受本规范约束 |

## 6. 作废口径（与本规范冲突的历史规则）

| 作废规则 | 替代 |
|---|---|
| 基座改动 push `origin/pin/nuwawork` | 基座一律 feat/* → PR → main（pin 线已退役删除） |
| `pin/nuwawork` 须快进（基座推送前） | 已实证推翻：gitlink 只须在 `.gitmodules` 声明分支可达；基座单主干后无快进对象 |
| 外层仓使用 `feat-<date>` / `feat-<user>.<date>` 人名日期线 | 外层仓工作分支一律 `<type>/<slug>`；人名日期线仅存于前端仓（对方惯例） |
| `bugfix/*` 前缀 | 并入 `fix/*` |

## 7. 存量分支处置清单（定档日盘点）

| 仓 | 分支 | 状态 | 处置 |
|---|---|---|---|
| 外层 | `main` | 主干 | 保留 |
| 外层 | `release/v1.0.x` | 版本线，领先 main 19 提交；v1.0.4 已转正 | 回流 main 后删除 |
| 外层 | `codex/download-redirect-closeout` | release 线基点；提交已在 release 线内可达 | 随 release 回流后一并删除 |
| 外层 | `archive/electron-client-1.0-full`、`archive/codex-agent-workbench-0.11` | 归档 | 保留 |
| 基座 | `main` | 主干 | 保留 |
| 基座 | `feat/agent-work-dir-absolute` 等历史 feat 线 | 逐条 `git branch --merged origin/main` 核实后删除 | 待清理 |
| 前端 | `feat-2026.9.30` | 我方消费线（.gitmodules 声明分支） | 保留至换线，换线须同步改 `.gitmodules` |
| 前端 | `pin/nuwawork`、`pin/nuwa-work` | 改名遗留 | 保留勿动 |

## 8. 速查

```bash
# 新建工作分支（push 不触发 CI；开 PR 回 main 才跑双轨门禁）
git checkout -b feat/<slug> main

# 切版本线
git checkout -b release/v1.0.x main

# 发预发 → 转正（重打同号 tag 前先删远端 tag 与 Draft Release）
git tag prerelease-v1.0.5 && git push origin prerelease-v1.0.5
git tag electron-v1.0.5  && git push origin electron-v1.0.5

# 版本线回流（转正后）
git checkout main && git merge --ff-only origin/release/v1.0.x && git push origin main
```
