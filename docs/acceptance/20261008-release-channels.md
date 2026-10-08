# 统一版本与更新通道验收

工作区：隔离 worktree `codex/release-channel-rules`，保留原检出 WIP。基线已纳入远端 `release/v3.0.x` 的 3.0.9 修复（a1e218bd）；前端源码 307a3d6b2，产物 67ac1ad。

## 质量三问

- 功能内聚：`scripts/release-version.mjs:7` 统一语法、身份、排序及占用规则，CLI、Actions 与来源清单共用；`scripts/publish-release-pointers.mjs:19` 集中处理备份、SemVer 检查、镜像写入、回读与回滚。安装包副作用与通道策略留在外层。
- 代码分层：基座只承载通用 SemVer、订阅初始化和签名目标参数；正式标签策略与镜像事务由商业层编排。`release-provenance.mjs:15` 明确区分执行工具与目标源码，历史续跑不依赖旧 tag 中的新工具。
- 可维护：拒绝不规范标签、通道冲突、同版本替换来源及降级；stable 默认停在签名阶段，验收后显式同步。旧标签与社区签名默认行为保留。真实子命令测试覆盖部分上传失败，GitHub Actions 使用统一锁避免两通道并发互相覆盖。

## 验证记录

社区门：1548 passed / 18 skipped。商业门（含最新 3.0.9 overlay）：2230 passed / 18 skipped。overlay:check、host-bridge:check 和本地 check:pin 通过。发布三套 workflow 经 actionlint 1.7.12 检查通过。

上述数量为本地 macOS 全量验证（签名重试修复前）；最终源提交 708a46cc 的 GitHub CI run 37732742041 在 Linux 上社区 1536 passed / 5 skipped，商业 2218 passed / 5 skipped，脚本 231 passed，前端门亦通过。平台用例与 skip 条件不同，数量不直接作为跨平台比较。

基座 PR：https://github.com/nuwax-ai/nuwa-electron-shell/pull/25，GitHub CI 与标题门均通过。已合入基座 main，pin 为 d078bb3cd87eb111a38299bb23d9dff819f53c13；overlay:compat 零重叠变化，远端 purity 通过。脚本全量 231 项通过，包含新增中断回滚用例。

## 实际 stable 验证

用户指定 GitHub Actions 五平台构建，首次使用 v3.0.10，按 Draft → Windows 签名 → 安装验收 → 镜像同步公开顺序执行。Actions run、安装包元数据、验签、真实升级结果及尚未具备的外部条件在后续记录中补齐；单测结果不等同于真实安装验收。

签名上传续跑修复通过基座 PR #26 合入 main，4 项实际 bash/gh 成功和失败测试通过。同步元数据使用固定 Release 创建时间，禁止网络失败时生成变化时间戳。


实际打包已启动：https://github.com/nuwax-ai/nuwax-client/actions/runs/37732833946 ，push 事件 tag v3.0.10，源码 708a46cc3e71783612f08454f9da94d0b9ad607d。确认仅 stable workflow 触发，规范身份校验、社区、商业及前端门均通过，五平台矩阵已启动。Release 状态为 Draft、非 prerelease。历史 electron-v3.0.9 的同步 run 37731331418 已成功完成。

商业 PR #13 的 CI 三轨均通过，已合入 release/v3.0.x，合并提交 9de6fa245ae1f1ee05735074afbe0dff281b9238；发布 tag 保持原源码 708a46cc，不移动。基座 PR #25、#26 均已先合入 main。

同步前基线（2026-10-08）：S3 与 OSS 的 stable 指针均为 3.0.9、SHA256 c9415920c17973fb3885ee5fdfac0c26fd3a21118b02aa326ab15e8f31dda15f；beta 指针均为 3.0.8、SHA256 9bf784ae8f6e93858d79bcb5f0900e6f604cb45ce7ed762f8c73d5c0097fd7a4。原字节保存在执行机 /tmp/nuwax-v3.0.10-pointer-baseline.json。正式同步将重新读取和校验指针。

真实安装环境基线：Mac /Applications/Nuwax.app 为 3.0.8，已保存 update_channel=beta；win-pc 已安装 Nuwax.exe 为 3.0.7（数字 ProductVersion 3.0.7.0），已保存 update_channel=stable。两台机器分别检查旧纯数字版本升级和用户订阅保留，结果待本次真实安装包就位后记录。
