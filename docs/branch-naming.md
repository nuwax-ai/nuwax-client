# 分支与 pin

适用于客户端与中立基座；前端仓使用其协作分支约定。

- 主干为 main，工作分支经 PR 合入。使用 `feat/`、`fix/`、`refactor/`、`chore/`、`docs/` 或 `codex/` 加简短的小写连字符名称；已有版本线继续使用 `release/vX.Y.x`。
- 一个分支保持一个目标；合并后可删除工作分支，需要留名的历史线使用 `archive/` 并冻结。
- 基座提交只含中立实现，商业差异落在外层 overlay；基座 pin 跟随 main，不 rebase 改写已被引用的 SHA。
- 前端源码和产物使用各自 gitlink 固定，产物提交仍被引用时不能改写历史。更新遵循 `.gitmodules` 中的消费分支，不要求 pin 等于远端最新。
- 发布由不可变 `vX.Y.Z` / `vX.Y.Z-beta.N` tag 驱动；Draft 同样占用版本。失败续跑同 tag/SHA，源码变化使用新版本，详见 [发布与更新通道](release-channels.md)。
- `main` 和 `release/**` 的 PR/push 按改动域执行 CI；普通工作分支 push 不跑源码门禁。发布 workflow 调用完整检查，具体规则见 [脚本参考](npm-scripts.md)。
