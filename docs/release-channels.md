# 客户端发布与更新通道

新发布标签统一为 `vX.Y.Z`（stable）、`vX.Y.Z-beta.N`（beta）、`vX.Y.Z-alpha.N`（Dev）。应用版本去掉 v 后完整保留 beta 后缀，安装包文件名、来源清单和 latest.json 使用同一版本。数字无前导零；beta 从 1 开始，每次取已占用最大序号加一。`alpha.2 < alpha.10 < beta.1 < stable`（同基础版本）。Dev 与 Beta 序号分别递增，均从 1 开始。

Beta 序号按完整 `X.Y.Z` 分别递增：存在 `3.1.1-beta.N` 标签时，`3.1.0-beta.N` 仍可使用自身的下一序号。新建标签与公开更新通道分别校验；同步时仍拒绝将已公开的较高版本降级，明确切换维护线须使用下文的通道替换记录。

可以直接发布 stable，也可以多轮 beta 后同号转正。正式 tag 创建即关闭同号 Dev / beta；Draft 也占用版本。失败重试使用同一 tag/SHA，修代码要升号，历史 tag 不移动。

## 发布入口

客户端以带版本号的 `alpha/v3.1.0` 分支集成 Dev 体验功能，前端源码仓也以 `alpha/v3.1.0` 分支作为对应消费线；客户端仍固定引用具体 gitlink，不随前端分支自动追新。PC Web 已有的 `dev` 部署分支保持原职责。成熟功能经独立 PR 回主干，主干和发布线修复按需回灌对应 Alpha 分支。分支版本表示维护线，安装包版本仍按发布版本规则独立校验。

推送 `alpha/**` 或向其提交 PR 运行 CI 门禁；正式 Dev 发布仍须创建 `vX.Y.Z-alpha.N` 标签，分支名称不会触发出包或更新订阅指针。产品中的通道名称保持 Dev。

```bash
npm run release -- --version 3.0.11-beta.6 --dry-run
npm run release -- --version 3.0.11-beta.6
npm run release -- --version 3.0.11 --dry-run
npm run release -- --version 3.0.11 --stage sign
# 真实安装包验收通过后
npm run release -- --version 3.0.11 --stage sync
# 用最新自动化代码续跑历史目标，不创建或移动历史标签
npm run release -- --tag electron-v3.0.9 --stage sign
npm run release -- --tag electron-v3.0.9 --stage sync
```

`--channel` 可省略；传入时必须与版本/tag 匹配。`--tag` 只接受已经存在的远端标签。说明文件为 `release-notes/<tag>.md`，须在目标发布提交中已提交。

当前客户端默认 direct，加载业务线上页面；打包前端用于显式 gateway 模式的本地承载，不因线上加载失败自动切换。发布 pin 无须追到远端最新，但必须在声明消费线历史中可达，源码/产物版本戳一致且兼容宿主接口。每个 tag 固定这些输入，打包期间不追新提交。

本集成分支为 Dev 提供独立的完整主题预览：默认关闭，由用户在「主题」页启用，使用该 Dev 包的固定前端源码构建。预览仅覆盖本次 Dev 运行的加载策略，不联动保存的本地加速配置；关闭后遵循原配置。Beta / Stable 保持原加载行为。Dev CI 从源码 pin 构建，不能用旧 `nuwax-dist` 产物是否含新主题来判断 Dev 包内容。

CLI 按预检时捕获的消费分支 SHA 核对历史关系，允许远端比 pin 更新，不把分支尖端替换成构建输入。`--tag` 续跑从目标发布提交的 `.gitmodules` 读取 URL 与消费分支，工具工作区换线不会改变历史目标。doctor/prepare 继续核对本地 HEAD 与已提交 pin、工作树及产物戳；这些检查不要求远端最新。

stable 打包 workflow 匹配 v* 并排除 v*-beta.* / v*-alpha.*；预发布 workflow 匹配 v*-beta.* / v*-alpha.*。两者先校验规范版本再运行门禁和五平台矩阵。分支 push/PR 只运行现有检查，失败通过原 run 重试。beta 全平台成功后自动公开 prerelease；stable 默认入口先保留 Draft 并完成签名，Windows 签名和安装包验收后显式同步。Windows 签名由发布入口显式传入 `SIGN_RELEASE_TAG`，历史 tag 格式仅在续跑指定目标时解析。

## CI 路由与脚本责任

| 入口 | 正式发布触发 | 成功后的行为 |
| --- | --- | --- |
| `release-electron.yml` | tag push `v*`，排除 `v*-beta.*` / `v*-alpha.*` | 校验身份 → 商业/前端/脚本门禁 → 五平台；保留 stable Draft，等待 win-pc 签名与安装验收 |
| `release-electron-dev.yml` | tag push `v*-beta.*` / `v*-alpha.*` | 校验身份 → 商业/前端/脚本门禁 → 五平台 → 自动调用同步，公开 prerelease |
| `sync-electron-to-oss.yml` | Dev / beta 自动调用；stable 或失败续跑手动 dispatch 原 tag | 最新工具与目标源码分别检出，校验签名/来源/哈希，上传版本目录，再事务更新指针与公开 Release |
| `ci.yml` | main、alpha/**、release/** 分支 push、对应 PR、发布 workflow 调用 | 社区、商业、前端检查，无正式安装包发布 |

仅修改 `release-notes/*.md` 的分支 push/PR 不触发 `ci.yml`，避免发布说明在 PR、合并、tag 三个入口重复占用 runner。改动包含源码、workflow、pin 或 `.channel.json` 时仍执行完整分支/PR 门禁；tag 发布调用 `ci.yml` 不受路径过滤影响，始终运行全部检查。

客户端和壳源码随本仓 tag 检出；仅前端源码与产物以固定 gitlink 检出，前端源码测试按需初始化其嵌套子模块。`source.shell` 记录本仓壳目录的 tree 哈希，不是外部仓库提交；工具链不取旧基座或执行覆写层同步。

Actions 的 `Queued` 先检查组织的 [GitHub-hosted runner 用量](https://github.com/organizations/nuwax-ai/settings/actions/hosted-runners)：并发额度跨仓库共享，macOS 还有单独上限。2026-10-26 排查 Beta.5 时组织为 20/20、macOS 为 5/5，其中 `nuwax-ai/codex` 三条工作流占用 14 个槽位。应清理已经被新运行覆盖的重复门禁，并由对应仓库负责人协调长构建；增加 job 超时时间不会解决分配 runner 前的排队。保留当前 tag/SHA 继续执行，勿为排队另起版本或重打整套包。

beta workflow 的手动与 `codex/beta-qa/**` 分支入口只产隔离 QA artifacts，不创建正式 tag/Release，不更新订阅入口。正式打包只用 tag push。非法 tag 在版本校验处失败，不进入测试门禁或五平台矩阵；有效 tag 只触发一套发布构建。

CLI 的 `--version` 是完整应用版本。`--channel beta --version 3.0.11` 会在副作用前报冲突；应使用 `--version 3.0.11-beta.6`。失败用 `gh run rerun <原 run id> --failed` 重试原 tag/SHA，或用 `npm run release -- --tag <原 tag>` 续跑；改源码后须发布下一个可用版本。

Windows 的 stable、beta 与 QA 打包共用 `configure-windows-output.mjs`，将 builder 输出放到 `RUNNER_TEMP/nw-<run>-<attempt>-<arch>`。来源记录、Release 上传和 QA staging 必须读取同一个 `NUWAX_WINDOWS_OUTPUT_DIR`，缺失时提前失败。完整版本仍注入应用与资产文件名，资源载荷保持完整。修改输出目录时须同时验证这些消费者；只设置 Git longpaths 不能保证 WiX 的原生文件访问支持长路径。

macOS 的 stable、beta 与 QA 使用 `ELECTRON_BUILDER_COMPRESSION_LEVEL=1` 覆盖客户端构建命令的 maximum。保留完整 DMG/ZIP、签名、公证和来源检查；较低压缩级别会增加包体。实际 SDK 25.1.8 的 ZIP/7z 参数回归防止再次遗漏。

公证后的安装包统一由 `release-mac-notarization.mjs` 生成。该入口在单次打包进程的 PATH 中提供临时 hdiutil 包装器，将 Intel 的 UDRW 中间镜像从 HFS+ 改为 APFS，保留现有 UDZO 压缩和完整应用。ARM 的 APFS 路径保持不变。包装器只透传系统工具的标准输出，分段耗时单独收集，结束后打印 create / resize / attach / detach / convert 耗时并清理临时文件；Intel 成功路径须确认真实执行过 APFS 中间镜像创建。打包前后继续检查应用签名与公证票据。stable、Beta 及私有验包共用该实现，已冻结的旧 tag 不变。

`package-validation.yml` 可选择 `mac-x64`，使用 `macos-26-intel` 原生签名验包；沿用既有 Beta/Stable 基线版本和四次启动限制，只上传私有 Actions artifacts，不创建 Release 或推进更新指针。

版本解析由 `release-version.mjs` 共用，CLI 编排在 `client/release.mjs`，来源核验在 `release-provenance.mjs`，镜像指针事务在 `publish-release-pointers.mjs`。签名机只处理安装包，安装验收和镜像发布由外层负责。

## 更新订阅

Dev 是独立的新功能体验通道，发布频率可以低于 Beta。设置中先开启 Beta 才显示 Dev 开关；主动开启 Dev 后只读取 `dev/latest.json`，仅接收 Dev 发布。Beta/Stable 发布不推进 Dev 指针，因此不会把用户从 Dev 新功能体验切走。关闭 Dev 回 Beta；关闭 Beta 同时退出 Dev，再次开启 Beta 不恢复 Dev。订阅选择跨重启和升级保留，Dev 包首次安装不自动启用 Dev。

普通更新检查不允许降级。用户主动切换订阅后，主进程保存绑定当前安装版本和目标通道的切换意图；只有基础版本相同、实际发布通道不同的较低版本才可作为候选。下载前重查固定版本清单，安装较低版本前显示当前版本与目标版本并单独确认，较低版本不允许退出时自动安装。跨基础版本、同一发布通道的回滚，以及安装版本或订阅已变化的旧意图均不放行。

下载/安装期间暂不可切换；其他时机切换会丢弃旧候选、重新检查并禁用旧包的退出安装。Dev 入口不可用时保留订阅并报告检查错误，不回退 Beta。已发布的旧客户端不会因发布 Alpha 自动获得新切换能力：`3.1.1-beta.6` 首次进入 `3.1.1-alpha.1` 需手动安装，后续 Beta 包含本逻辑后才可直接切换。

Dev 版本为 `X.Y.Z-alpha.N`，发布入口为 `npm run release -- --version X.Y.Z-alpha.N --dry-run`；正式执行时去掉 `--dry-run`。Dev 复用 Beta 的五平台源码 pin 构建与来源核验、macOS 签名/公证和 Windows unsigned 策略，版本资产独立放在 `nuwax-electron/dev-build/<dev-tag>/`。`--channel dev` 只校验推导结果，`--stage sign` 仅支持 Stable。

stable 用户只读取 `latest/latest.json`；beta 用户读取 `beta/latest.json`，其中可指向 beta 或正式版。用户升级到正式包后仍保留 beta 订阅；切回 stable 不自动降级，等待正式版本追上。

beta 发布只推进 beta 指针。stable 发布推进 stable 指针，在版本更高时也提升 beta 指针；已有更高 beta 时保留它。三个通道的同步工作流共用并发锁，在版本目录和来源哈希验证后读取两镜像原指针，拒绝不一致、同版本换来源和降级；写入后回读核对，失败恢复已写指针。镜像尚无指针时视为首次发布。

明确切换 Beta 维护线时，可在目标发布提交中增加 `release-notes/<tag>.channel.json`，固定目标 Beta tag、原 Beta 版本和原指针完整 SHA256，并说明原因。CLI 与指针事务只允许该目标替换两镜像中完全匹配的旧指针；stable、其他 tag、旧指针被推进或改写时仍拒绝降级，失败仍回滚。3.0.20 的 Beta 候选使用此记录从 `3.1.0-beta.5` 切回 3.0 维护线；`beta.1`、`beta.2` 已停止且未发布，后续源码使用下一可用 Beta 编号。已经安装 3.1 Beta 的客户端需手动安装 3.0 Beta。

路径保留 `nuwax-electron/<stable-tag>/` 和 `nuwax-electron/beta-build/<beta-tag>/`。新元数据必须携带 yml URL；原有字段及旧标签目录不迁移。手动同步使用 workflow 所在提交的工具，来源验证对目标 tag 的独立检出执行。

## S3 校验与同步耗时

上传用 AWS CLI classic、8 MiB 分片及 `--checksum-algorithm SHA256`。`release-storage-integrity.mjs` 在来源校验后记录完整 SHA256、大小和 S3 SHA256（大文件为 composite），放入来源清单的可选 `s3Checksums`；`latest.json` 格式保持兼容。CI 与 CLI 通过匿名 HEAD 的 checksum-mode 核对服务端保存的 SHA256 与大小，新资产无需再次完整下载。

历史资产/清单或存储端缺 SHA256 时仍完整读回 SHA256，最多四路并行；校验值或大小不符直接失败，不转成宽松校验。任何读流/子命令失败都阻止发布，等待已启动读流结束后才返回失败。来源清单自身及 OSS 小元数据仍完整读取。日志逐文件显示校验方式与耗时。multipart ETag、文件大小或用户自填 metadata 不作为完整性证明。

v3.0.10 同步 run 37741910045 的 28 个资产共 7,766,653,598 字节：GitHub 下载 3m42s、S3 上传 5m22s、旧串行 S3 校验 5m22s，OSS 两步各 5s。该版本沿原流程完成验证并公开。v3.0.11-beta.4 的同步 job 113295991814 实测 GitHub 下载 60s、S3 上传 4m45s、S3 校验 6s（11:56:52–11:56:58 UTC），校验耗时较旧流程减少约 98%。大包使用服务端 SHA256 COMPOSITE，小资产使用 FULL_OBJECT；仅小型 latest.json 和来源清单完整读回。两个版本包体与输入不同，此处为实际发布对照。上传/下载仍受带宽影响；既有 tag 不重传或改动。

依据：[AWS CLI 校验说明](https://docs.aws.amazon.com/cli/latest/topic/s3-faq.html)、[S3 SHA256 分片与校验类型](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html)。固定分片配置见同步 workflow，不要单独修改其中一处。

## 历史首次上线与迁移（2026-10）

旧客户端只接受纯数字更新元数据。先发布包含更新器兼容修复的 `v3.0.10` 正式版，并提升 stable、beta 两个订阅入口，旧用户即可自动升级。之后进入 `v3.0.11-beta.N` 新序列，当时的发布候选为 `v3.0.11-beta.6`，包含 source 4dfea90cd2 / dist 4a497a055。发布前重新检查远端占用；历史 `electron-v*` / `prerelease-v*` 标签、资产路径和来源记录保留，续跑时用 `--tag` 传入原值。

单元测试不能替代安装包验收：正式上线前验证真实包版本、签名、旧版升级、beta 连续升级和同号转正，记录平台与实际结果。

依据：[electron-builder 通道包含模型](https://www.electron.build/v26/docs/tutorials/release-using-channels/)、[GitHub tag 过滤规则](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpushbranchestagsbranches-ignoretags-ignore)。

Windows 签名机职责收敛为下载、缓存/下载哈希验证、签名、验签、上传；当前已提交签名工具由外层通过 SSH stdin 提供。应用来源校验留在外层，签名机无需客户端源码检出或 npm 安装，并保留 tag/SHA 缓存供失败续跑。

旧 beta 客户端首次接入新序列应先升级兼容正式版 3.0.10。若尚未升级而 beta 入口已进入 beta.N，可临时订阅 stable 获得 3.0.10，再按用户选择订阅 beta；已有用户选择不会被安装包覆盖。

2026-10-08：beta.1、beta.2 因补充分支整合取消；beta.3 的 Windows MSI 遇到 260 字符文件路径，修复需要变更 workflow，取消原 run。三个 tag/SHA 和 Draft 均保留，未公开且继续占用序号。beta.4 已在 21f4500f 完成五平台构建、公开 prerelease 与双镜像同步。beta.5 固定在 d3aca75a，曾因准备更新前端双 pin 取消构建；用户随后要求先完成本轮打包，已在同 tag/SHA 重跑 run 37772988364。后续前端更新独立交付，不移动 beta.5。示例版本以发布前远端占用检查为准。

2026-10-08 后续：用户指出 beta.5 仍在 d3aca75a，要求先合并 codex/frontend-beta5-pins 再重打。已补齐 frontend-beta5-pins 与 frontend-pin-policy 的完整合并历史；beta.5 构建取消、旧 tag/SHA/Draft 保留，新源码使用下一可用 beta.6。合并后应用与校验代码树与 PR #20 商业/前端/脚本门禁通过的 021d6ec3 一致，本次仅补合并关系和下一版发布说明。
