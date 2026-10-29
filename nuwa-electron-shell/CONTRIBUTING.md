# Nuwax 客户端贡献指南

本目录是 `nuwax-client` 的源码组成部分，代码与工具统一在当前仓库维护。

- 开发规则以[根 AGENTS.md](../AGENTS.md)和本目录 [AGENTS.md](./AGENTS.md)为准。
- 分支从目标维护线创建，按[分支规范](../docs/branch-naming.md)提交 PR；不要另建旧基座仓库的 PR 或更新壳目录 pin。
- 一次改动聚焦一个问题，保留无关 WIP；提交说明描述实际行为和验证结果。
- 日常命令从仓库根运行，见[npm 脚本参考](../docs/npm-scripts.md)。测试按改动域执行；源码测试不代替安装包验收。
- 评审按[REVIEW.md](../REVIEW.md)执行，作者不自行批准 PR。许可证及第三方归属记录继续保留。
