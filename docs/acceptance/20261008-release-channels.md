# 统一版本与更新通道验收

工作区：隔离 worktree `codex/release-channel-rules`，保留原检出 WIP。基线已纳入远端 `release/v3.0.x` 的 3.0.9 修复（a1e218bd）；前端源码 307a3d6b2，产物 67ac1ad。

## 质量三问

- 功能内聚：`scripts/release-version.mjs:7` 统一语法、身份、排序及占用规则，CLI、Actions 与来源清单共用；`scripts/publish-release-pointers.mjs:19` 集中处理备份、SemVer 检查、镜像写入、回读与回滚。安装包副作用与通道策略留在外层。
- 代码分层：基座只承载通用 SemVer、订阅初始化和签名目标参数；正式标签策略与镜像事务由商业层编排。`release-provenance.mjs:15` 明确区分执行工具与目标源码，历史续跑不依赖旧 tag 中的新工具。
- 可维护：拒绝不规范标签、通道冲突、同版本替换来源及降级；stable 默认停在签名阶段，验收后显式同步。旧标签与社区签名默认行为保留。真实子命令测试覆盖部分上传失败，GitHub Actions 使用统一锁避免两通道并发互相覆盖。

## 验证记录

社区门：1548 passed / 18 skipped。商业门（含最新 3.0.9 overlay）：2230 passed / 18 skipped。overlay:check、host-bridge:check 和本地 check:pin 通过。发布三套 workflow 经 actionlint 1.7.12 检查通过。

基座 PR：https://github.com/nuwax-ai/nuwa-electron-shell/pull/25，GitHub CI 与标题门均通过。已合入基座 main，pin 为 d078bb3cd87eb111a38299bb23d9dff819f53c13；overlay:compat 零重叠变化，远端 purity 通过。脚本全量 230 项通过（新增中断回滚用例另行通过）。

## 实际 stable 验证

用户指定 GitHub Actions 五平台构建，首次使用 v3.0.10，按 Draft → Windows 签名 → 安装验收 → 镜像同步公开顺序执行。Actions run、安装包元数据、验签、真实升级结果及尚未具备的外部条件在后续记录中补齐；单测结果不等同于真实安装验收。

签名上传续跑修复通过基座 PR #26 合入 main，4 项实际 bash/gh 成功和失败测试通过。同步元数据使用固定 Release 创建时间，禁止网络失败时生成变化时间戳。
