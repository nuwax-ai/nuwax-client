# 客户端分支规范

本文约束 `nuwax-client` 的源码、工具链和发布维护。`nuwa-electron-shell/` 是本仓源码目录，不拥有独立分支或 pin；前端仓命名由对应团队维护，本仓只约束消费方式。

## 工作分支

采用 `<type>/<slug>`，slug 用小写英文和连字符，描述改动意图。一个分支聚焦一个主题。

| 类型 | 用途 | 示例 |
|---|---|---|
| `feat` | 新功能 | `feat/workspace-preview` |
| `fix` | 缺陷修复 | `fix/capture-shortcut` |
| `refactor` | 等价重构 | `refactor/client-tooling` |
| `chore` | 构建、依赖、脚本 | `chore/update-frontend-pins` |
| `docs` | 文档 | `docs/client-maintenance` |
| `codex` | 隔离任务工作分支 | `codex/release-review` |

从明确的目标主干或维护线创建工作分支，PR 回同一目标线。main 是集成主干，经 PR 合入；跨版本回补另建明确范围的 PR 或 cherry-pick，不整批混入其他版本功能。`dependabot/*` 保留给 bot。

## 当前维护与历史分支

- 当前 3.1.0 目标线为 `release/v3.1.0`，沿用用户指定的完整版本分支名。
- 原 `release/v3.1` 保留作历史参考，不整分支合并；需要的单项功能按明确范围 cherry-pick，并以当前实现重新验证。
- 新版本线从明确验证过的提交创建，名称按该次发布决定，不为整理命名改写现有分支。
- 合入后的工作分支可清理，但仍被发布、pin 或 QA 引用的分支/提交保留。归档只冻结历史，不改写已发布来源。

## 前端消费

仅 `nuwax/`、`nuwax-dist/` 是子模块，URL 和消费分支以 `.gitmodules` 为准。当前前端源码消费 `feat-2026.9.30`，产物消费 `main`。被引用提交须在声明分支历史中可达，不要求 pin 等于远端最新。

更新前端走根 `npm run sub:update`，保护无关 WIP，提交源码与产物双 pin；不改写仍被历史 tag 引用的提交，也不擅自改前端团队的分支命名。

## 测试与发布

- 根 `npm run test:commercial` 为完整客户端测试入口，`npm run test:scripts` 为工具链检查。壳与工具链同仓修改，不存在跨仓同步或社区测试轨。
- `ci.yml` 对 main/release 分支 push、目标 PR 和发布调用运行门禁；仅发布说明 Markdown 的分支变更不重复触发整组门禁，tag 发布仍完整验证。
- `vX.Y.Z` 触发 stable，`vX.Y.Z-beta.N` 触发 beta。Beta 序号取最大已占用值加一，Draft 和失败 tag 也占用版本。
- 历史 tag 不删除、不移动、不重打；同 tag/SHA 可续跑失败步骤，源码修复需要下一个版本。stable 必须完成签名与安装验收后显式同步，beta 五平台成功后按规范自动同步。

具体入口见[npm 脚本](./npm-scripts.md)与[发布规范](./release-channels.md)。本文不用于重新处置旧文档中的历史分支清单。
