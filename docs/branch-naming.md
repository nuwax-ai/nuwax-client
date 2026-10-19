# 分支、版本与 pin

本页约束 nuwax-client 外层产品仓。中立基座保持自己的单主干流程；前端仓和产物仓遵循各自协作约定与 `.gitmodules` 消费分支，不能把外层版本线套到子模块上。

## 命名与职责

| 类型 | 规则与示例 | 生命周期 |
| --- | --- | --- |
| 长期主干 | `main` | 汇总经验证的产品改动与版本线修复；main 尖端不等于已公开版本 |
| 版本开发/维护线 | 新线统一 `release/v<major>.<minor>`，当前为 `release/v3.1` | 同一条线承载该 minor 的 Beta、转正和后续补丁；不为每个 Beta 或 patch 再建长期线 |
| 功能任务线 | `feat/<topic>` | 新功能；人和 Agent 使用同一规则，从明确目标线创建并经 PR 回流 |
| 修复任务线 | `fix/<topic>`，如 `fix/windows-first-install-speed`、`fix/nw-104-install-speed` | 问题修复与性能优化；一个分支一个目标 |
| 其他任务线 | `refactor/<topic>`、`chore/<topic>`、`docs/<topic>` | 分别表示行为保持的重构、工程/工具链维护、纯文档；不按执行者或 Agent 品牌分组 |
| 隔离 QA 构建线 | `qa/X.Y.Z-qa.YYYYMMDD.N`，如 `qa/3.1.0-qa.20261019.1` | 特殊构建入口，固定一次源码 SHA；重做源码用新的 attempt/分支，不复用旧身份 |
| 历史归档 | `archive/<original-topic>` | 保留需要追溯的历史线，冻结后不继续开发 |
| 依赖机器人 | 保留 `dependabot/...` 等工具命名 | 不改机器人自有命名规则 |

`release/v3.1` 比 `release/v3.1.x` 更简洁，二者表达的都是 3.1 系列；现统一前者，避免同一系列保留两个可写入口。已有 `release/v3.0.x`、`release/v1.0.x` 属历史名称，继续按原接手范围处理，不为命名一致性批量改写或删除。

topic 用简短小写英文、数字与连字符；版本信息由 PR base 表达。不按 Codex、Claude、Cursor 或具体人员命名新分支。历史 `codex/*` 等分支保留原引用，后续新任务按工作性质命名。

不新增 `develop`、`beta`、`stable` 等长期并行分支。Beta/stable 是版本和更新订阅的属性，用 tag 与发布元数据表达；任务分支不以 `beta5-release` 这类名字充当长期版本线。现有任务分支不因规则更新强制改名。

## 分支起点与合并方向

1. 新版本线从已核对的集成基线切出。3.1 已采用含 beta.7 和卸载名称修复的 `9b8f0698` 基线，不因旧 main 归档尚在进行而重建历史。
2. 3.1 任务从 `release/v3.1` 创建，PR 回到 `release/v3.1`；面向主干的中立工具/通用工作从 main 创建，PR 回 main。创建前说明目标，避免把不同版本的完整提交树互相倒入。
3. 维护旧版本时，在该版本线修复；需要后续版本的修复通过独立 PR 向前同步，并记录原提交。版本线整合回 main 也经 PR，保留已发布提交历史；3.0 归档继续由原接手人执行。
4. main 的变更进入版本线需显式评估范围与 pin。main 更新或合并完成不等于自动发布，也不要求版本线随时追到 main 尖端。
5. 工作分支合并后，确认所需提交在目标线、tag 或其他保留引用中可追溯，再删除工作引用。未合并、仍有 WIP/验收用途的分支先保留；不批量清理他人的线。

版本线改名时核对新旧 SHA 一致，先迁移打开的 PR base 与本地 tracking、现行文档，再移除旧远端引用；历史 tag/Release/已固定 pin 不改写。受保护规则、默认分支或外部集成也需随实际依赖核对，不把创建同 SHA 的新分支当作迁移完成。

## 版本、QA 与 CI

- 发布用不可变 `vX.Y.Z-beta.N` / `vX.Y.Z` tag，如 `v3.1.0-beta.1`、`v3.1.0`、`v3.1.1`。Draft 同样占号；失败续跑同 tag/SHA，修源码用下一可用版本，详见[发布与更新通道](release-channels.md)。
- 普通任务分支 push、`release/**` push 不触发 `ci.yml` 源码门禁；main push 和指向 main / `release/**` 的 PR 按改动域执行。发布 workflow 调用完整检查。release 线通过 PR 交付，不用“已 push”代替“门禁已通过”。
- `qa/**` 特殊分支 push 或显式 QA dispatch 仅输出隔离 Actions artifacts，不创建公开 tag/Release 或更新源。名称必须符合完整 QA 版本校验；旧 `codex/beta-qa/**` 保留历史引用与冻结 workflow，不作为当前工作流的新入口。
- 这是协作规则；GitHub 是否强制必须 PR/检查，由仓库 protection/rulesets 的实际配置决定。不能把规则文档视为服务端已开启保护。

具体执行规则见[脚本参考](npm-scripts.md)和 `.github/workflows/ci.yml`、`release-electron-dev.yml`。调整触发逻辑时同时更新这些消费者与相关脚本检查。

## 子模块与来源

- 中立基座：任务线经 PR 进入基座 main，本仓 pin 只固定经验证且远端可取的 SHA；不 rebase 改写已被引用的基座历史。商业差异留在外层 overlay。
- 前端源码：使用自身协作线；源码 pin 必须在 `.gitmodules` 声明的消费线历史中可达。本仓 3.1 开发线不自动改变其分支或 pin。
- 前端产物：沿用产物仓 main，以 gitlink 和 `version.json` 对应源码 pin。仍被引用的提交不能改写历史；pin 不要求等于远端最新。
