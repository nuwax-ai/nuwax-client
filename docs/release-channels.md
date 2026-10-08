# 客户端发布与更新通道

新发布标签统一为 `vX.Y.Z`（stable）、`vX.Y.Z-beta.N`（beta）。应用版本去掉 v 后完整保留 beta 后缀，安装包文件名、来源清单和 latest.json 使用同一版本。数字无前导零；beta 从 1 开始，每次取已占用最大序号加一。`beta.2 < beta.10 < stable`。

可以直接发布 stable，也可以多轮 beta 后同号转正。正式 tag 创建即关闭同号 beta；Draft 也占用版本。失败重试使用同一 tag/SHA，修代码要升号，历史 tag 不移动。

## 发布入口

```bash
npm run release -- --version 3.0.11-beta.2 --dry-run
npm run release -- --version 3.0.11-beta.2
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

## CI 路由与脚本责任

| 入口 | 正式发布触发 | 成功后的行为 |
| --- | --- | --- |
| `release-electron.yml` | tag push `v*`，排除 `v*-beta.*` | 校验身份 → 三轨门禁 → 五平台；保留 stable Draft，等待 win-pc 签名与安装验收 |
| `release-electron-dev.yml` | tag push `v*-beta.*` | 校验身份 → 三轨门禁 → 五平台 → 自动调用同步，公开 prerelease |
| `sync-electron-to-oss.yml` | beta 自动调用；stable 或失败续跑手动 dispatch 原 tag | 最新工具与目标源码分别检出，校验签名/来源/哈希，上传版本目录，再事务更新指针与公开 Release |
| `ci.yml` | main/release 分支 push、对应 PR、发布 workflow 调用 | 社区、商业、前端检查，无正式安装包发布 |

beta workflow 的手动与 `codex/beta-qa/**` 分支入口只产隔离 QA artifacts，不创建正式 tag/Release，不更新订阅入口。正式打包只用 tag push。非法 tag 在版本校验处失败，不进入测试门禁或五平台矩阵；有效 tag 只触发一套发布构建。

CLI 的 `--version` 是完整应用版本。`--channel beta --version 3.0.11` 会在副作用前报冲突；应使用 `--version 3.0.11-beta.2`。失败用 `gh run rerun <原 run id> --failed` 重试原 tag/SHA，或用 `npm run release -- --tag <原 tag>` 续跑；改源码后须发布下一个可用版本。

版本解析由 `release-version.mjs` 共用，CLI 编排在 `client/release.mjs`，来源核验在 `release-provenance.mjs`，镜像指针事务在 `publish-release-pointers.mjs`。签名机只处理安装包，安装验收和镜像发布由外层负责。

## 更新订阅

stable 用户只读取 `latest/latest.json`；beta 用户读取 `beta/latest.json`，其中可指向 beta 或正式版。用户升级到正式包后仍保留 beta 订阅；切回 stable 不自动降级，等待正式版本追上。

beta 发布只推进 beta 指针。stable 发布推进 stable 指针，在版本更高时也提升 beta 指针；已有更高 beta 时保留它。同步工作流共用并发锁，在版本目录和来源哈希验证后读取两镜像原指针，拒绝不一致、同版本换来源和降级；写入后回读核对，失败恢复已写指针。镜像尚无指针时视为首次发布。

路径保留 `nuwax-electron/<stable-tag>/` 和 `nuwax-electron/beta-build/<beta-tag>/`。新元数据必须携带 yml URL；原有字段及旧标签目录不迁移。手动同步使用 workflow 所在提交的工具，来源验证对目标 tag 的独立检出执行。

## S3 校验与同步耗时

上传用 AWS CLI classic、8 MiB 分片及 `--checksum-algorithm SHA256`。`release-storage-integrity.mjs` 在来源校验后记录完整 SHA256、大小和 S3 SHA256（大文件为 composite），放入来源清单的可选 `s3Checksums`；`latest.json` 格式保持兼容。CI 与 CLI 通过匿名 HEAD 的 checksum-mode 核对服务端保存的 SHA256 与大小，新资产无需再次完整下载。

历史资产/清单或存储端缺 SHA256 时仍完整读回 SHA256，最多四路并行；校验值或大小不符直接失败，不转成宽松校验。任何读流/子命令失败都阻止发布，等待已启动读流结束后才返回失败。来源清单自身及 OSS 小元数据仍完整读取。日志逐文件显示校验方式与耗时。multipart ETag、文件大小或用户自填 metadata 不作为完整性证明。

v3.0.10 同步 run 37741910045 的 28 个资产共 7,766,653,598 字节：GitHub 下载 3m42s、S3 上传 5m22s、旧串行 S3 校验 5m22s，OSS 两步各 5s。该版本沿原流程完成验证并公开；新路径在下一次 beta Actions 中验证实际收益，不重传或改动既有 tag。上传/下载本身的传输耗时仍受带宽影响。

依据：[AWS CLI 校验说明](https://docs.aws.amazon.com/cli/latest/topic/s3-faq.html)、[S3 SHA256 分片与校验类型](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html)。固定分片配置见同步 workflow，不要单独修改其中一处。

## 首次上线

旧客户端只接受纯数字更新元数据。先发布包含更新器兼容修复的 `v3.0.10` 正式版，并提升 stable、beta 两个订阅入口，旧用户即可自动升级。之后从 `v3.0.11-beta.2` 开始新序列。发布前重新检查远端占用；历史 `electron-v*` / `prerelease-v*` 标签、资产路径和来源记录保留，续跑时用 `--tag` 传入原值。

单元测试不能替代安装包验收：正式上线前验证真实包版本、签名、旧版升级、beta 连续升级和同号转正，记录平台与实际结果。

依据：[electron-builder 通道包含模型](https://www.electron.build/v26/docs/tutorials/release-using-channels/)、[GitHub tag 过滤规则](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpushbranchestagsbranches-ignoretags-ignore)。

Windows 签名机职责收敛为下载、缓存/下载哈希验证、签名、验签、上传；当前已提交签名工具由外层通过 SSH stdin 提供。应用来源校验留在外层，签名机无需源码、子模块、overlay 或 npm 安装，并保留 tag/SHA 缓存供失败续跑。

旧 beta 客户端首次接入新序列应先升级兼容正式版 3.0.10。若尚未升级而 beta 入口已进入 beta.N，可临时订阅 stable 获得 3.0.10，再按用户选择订阅 beta；已有用户选择不会被安装包覆盖。

2026-10-08：beta.1 已创建但因补充分支整合取消，未公开，序号仍被占用。首次公开候选为 beta.2；示例版本以发布前远端占用检查为准。
