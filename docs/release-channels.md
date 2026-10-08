# 客户端发布与更新通道

新发布标签统一为 `vX.Y.Z`（stable）、`vX.Y.Z-beta.N`（beta）。应用版本去掉 v 后完整保留 beta 后缀，安装包文件名、来源清单和 latest.json 使用同一版本。数字无前导零；beta 从 1 开始，每次取已占用最大序号加一。`beta.2 < beta.10 < stable`。

可以直接发布 stable，也可以多轮 beta 后同号转正。正式 tag 创建即关闭同号 beta；Draft 也占用版本。失败重试使用同一 tag/SHA，修代码要升号，历史 tag 不移动。

## 发布入口

```bash
npm run release -- --version 3.0.11-beta.1 --dry-run
npm run release -- --version 3.0.11-beta.1
npm run release -- --version 3.0.11 --dry-run
npm run release -- --version 3.0.11 --stage sign
# 真实安装包验收通过后
npm run release -- --version 3.0.11 --stage sync
# 用最新自动化代码续跑历史目标，不创建或移动历史标签
npm run release -- --tag electron-v3.0.9 --stage sign
npm run release -- --tag electron-v3.0.9 --stage sync
```

`--channel` 可省略；传入时必须与版本/tag 匹配。`--tag` 只接受已经存在的远端标签。说明文件为 `release-notes/<tag>.md`，须在目标发布提交中已提交。

stable 打包 workflow 匹配 v* 并排除 v*-beta.*；beta workflow 匹配 v*-beta.*。两者先校验规范版本再运行门禁和五平台矩阵。分支 push/PR 只运行现有检查，失败通过原 run 重试。beta 全平台成功后自动公开 prerelease；stable 默认入口先保留 Draft 并完成签名，Windows 签名和安装包验收后显式同步。Windows 签名显式传入 `SIGN_RELEASE_TAG`，基座默认保持社区的 electron-v 格式。

## 更新订阅

stable 用户只读取 `latest/latest.json`；beta 用户读取 `beta/latest.json`，其中可指向 beta 或正式版。用户升级到正式包后仍保留 beta 订阅；切回 stable 不自动降级，等待正式版本追上。

beta 发布只推进 beta 指针。stable 发布推进 stable 指针，在版本更高时也提升 beta 指针；已有更高 beta 时保留它。同步工作流共用并发锁，在版本目录和来源哈希验证后读取两镜像原指针，拒绝不一致、同版本换来源和降级；写入后回读核对，失败恢复已写指针。镜像尚无指针时视为首次发布。

路径保留 `nuwax-electron/<stable-tag>/` 和 `nuwax-electron/beta-build/<beta-tag>/`。新元数据必须携带 yml URL；原有字段及旧标签目录不迁移。手动同步使用 workflow 所在提交的工具，来源验证对目标 tag 的独立检出执行。

## 首次上线

旧客户端只接受纯数字更新元数据。先发布包含更新器兼容修复的 `v3.0.10` 正式版，并提升 stable、beta 两个订阅入口，旧用户即可自动升级。之后从 `v3.0.11-beta.1` 开始新序列。发布前重新检查远端占用；已有 `electron-v3.0.9` Draft 保留，不改其内容或标签。

单元测试不能替代安装包验收：正式上线前验证真实包版本、签名、旧版升级、beta 连续升级和同号转正，记录平台与实际结果。

依据：[electron-builder 通道包含模型](https://www.electron.build/v26/docs/tutorials/release-using-channels/)、[GitHub tag 过滤规则](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpushbranchestagsbranches-ignoretags-ignore)。
