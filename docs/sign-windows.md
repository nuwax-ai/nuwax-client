# Nuwax 商业版 — stable Windows 人工签名 Runbook（Certum SimplySign）

> 完整工具链安装（SimplySign Desktop、signtool、gh CLI、Git Bash）与排障见
> 基座内 `nuwa-electron-shell/crates/agent-electron-client/docs/windows-signing.md`，
> 本文只记录商业版差异：目标仓库、产物名、数据目录与社区版完全隔离。

## 前置（一次性）

1. Windows 签名机安装并登录 **Certum SimplySign Desktop**（手机 APP 动态 token 2FA）——
   与社区版**共用同一张证书**（SmartScreen 信誉共享）。
2. 设置环境变量（Git Bash，可写入 `~/.bashrc`）：

   ```bash
   export WINDOWS_CERTIFICATE_SHA1="<证书指纹>"           # 必需
   export WINDOWS_TIMESTAMP_URL="http://timestamp.sectigo.com"  # 默认值
   ```

3. `gh auth login` 完成 GitHub CLI 登录（需对 `nuwax-ai/nuwax-client` 有 Release 写权限）。
4. SSH 编排只需要签名机的 Git Bash、Node、gh 与签名工具/证书环境；无需 clone 应用仓库、安装 npm 依赖或同步 overlay。
   本地开发入口 `npm run sign:win` 仍可在已有开发检出中使用。

## stable 发版流程（每次）

CI 在 nuwax-client 打 `v{v}` tag 后产出**未签名**产物
`Nuwax-Setup-{v}-unsigned.exe`（以及最终名 MSI，不签名）。

```bash
cd <nuwax-client 检出>/nuwa-electron-shell/crates/agent-electron-client

version=3.0.10
tag="v${version}"
SIGN_RELEASE_TAG="$tag" SIGN_RELEASE_REPO=nuwax-ai/nuwax-client \
SIGN_WORK_DIR=/c/tmp/nuwax-sign \
SIGN_WIN_ARTIFACT_PREFIX="Nuwax" \
npm run sign:win -- "$version"
```

等价简写（外层仓库根，`scripts/client/forward.mjs` 自动注入
`SIGN_RELEASE_REPO` 与 `SIGN_WIN_ARTIFACT_PREFIX=Nuwax`，其余参数原样透传）：

```bash
npm run sign:win -- <version>
```

说明：

- **产物前缀必须显式指定 `Nuwax`**：CI 在构建时覆写
  `build.productName=Nuwax`，而本地基座 package.json 的默认 productName 是
  社区版 `NuwaClaw`——脚本的自动派生在商业场景下取错值，务必带
  `SIGN_WIN_ARTIFACT_PREFIX="Nuwax"`。
- 脚本流程：下载 unsigned EXE → signtool（`/sha1` 指纹 + RFC3161 时间戳）→
  `signtool verify //pa //all` → 重命名 `Nuwax.Setup.{v}.exe` → 上传并删除
  Release 上的 unsigned 资产。
- CI 的 Windows 构建清单记录 unsigned EXE 的大小、SHA256 和签名不变 PE 字节摘要。
  同步门禁在校验签名后，要求签名版 EXE 除 PE 校验和、证书目录及末尾新增证书外，
  原始字节与该清单一致；即使 Release 已删 unsigned EXE，也能核对签名包来源。
  缺少该记录的旧构建清单不能通过新同步门禁；需要重同步时须重新构建。
- 排障（Release 资产名对照、gh 找不到等）见基座 windows-signing.md 同名章节。

## SSH 远程签名：只下载、签名、上传

从 mac 运行外层 `npm run release`。正式包先由 GitHub Actions 构建，外层核对目标 tag/SHA、五平台来源及 Windows unsigned 清单，再通过 SSH 将**当前自动化提交所 pin 的基座签名工具**传给 `win-pc`。工具通过 stdin 传输，避免 Windows 命令长度限制。

Windows 端只执行以下安装包步骤：

1. 按目标 tag 下载 unsigned EXE；缓存和新下载的字节均须匹配 CI 清单 SHA256。
2. 使用 Certum SimplySign 签名并以 signtool 验签；手机认证仍由用户完成。
3. 上传签名 EXE 成功后才删除 Release 上的 unsigned 资产。失败保留安装包缓存，以原 tag/SHA 重跑。

签名机不检出源码、不初始化子模块、不同步 overlay、不构建，也不清理任何开发 worktree。临时签名工具在该次任务结束时移除，安装包缓存保留在 `/c/tmp/nuwax-sign/<tag>-<source SHA 前12位>/`。来源校验、真实安装验收和 OSS/S3 同步属于外层发布流程。

```bash
npm run release -- --version 3.0.10 --stage sign
# 历史 tag 续跑：使用当前已提交工具，目标源码固定在原 tag
npm run release -- --tag v3.0.10 --stage sign
# 完成真实安装包验收后再同步、公开
npm run release -- --tag v3.0.10 --stage sync
```

stable 默认停在签名阶段并保留 Draft。`--stage sync` 缺签名资产时会拒绝；beta 不使用 `--stage sign`。`--channel` 仅作版本/tag 的一致性校验。发布说明使用已提交的 `release-notes/<tag>.md`，历史 tag 续跑不得修改其源码和说明。

签名机一次性环境：`gh auth login`、SimplySign Desktop、Windows SDK signtool 与 Node。SSH 会话须显式加入 `/c/Program Files/GitHub CLI`，编排已内置；证书环境由现有 Git Bash 登录环境提供，密钥不进入仓库或日志。

现场排查可在已部署的工具目录直接运行（不需要应用源码）：

```bash
SIGN_RELEASE_TAG=v3.0.10 SIGN_RELEASE_REPO=nuwax-ai/nuwax-client \
SIGN_WORK_DIR=/c/tmp/nuwax-sign/v3.0.10-708a46cc3e71 \
SIGN_WIN_ARTIFACT_PREFIX=Nuwax SIGN_SKIP_BLOCKMAP=true \
bash ./sign-release-win-v2.sh 3.0.10
```

只有 unsigned 文件 SHA256 与构建清单一致时才可加 `--skip-download`；自动编排已执行该验证。签名缓存无人自动清理，需要时手动清旧 tag 目录。默认不生成签名版 blockmap，Windows 自动更新走全量下载。

## 同步 OSS（stable 须先完成上面签名）

```bash
cd <nuwax-client 检出>/nuwa-electron-shell/crates/agent-electron-client

SYNC_OSS_REPO=nuwax-ai/nuwax-client \
SYNC_OSS_REF=release/v3.0.x \
npm run sync:oss -- v<version> stable
```

等价简写（外层仓库根，`SYNC_OSS_REPO` 注入、`SYNC_OSS_REF` 默认取当前分支——
须在目标发布线分支上运行）：

```bash
npm run sync:oss -- v<version> stable
```

- `SYNC_OSS_REF` 应填已提交并推送的自动化分支（示例为 `release/v3.0.x`）。同步工具从该 ref 检出，目标 tag 源码另行检出用于来源校验；历史 tag 无需包含新工具。脚本在基座目录运行时不可依赖其默认 ref。
- 通道根由**壳仓 workflow 的 RELEASE_ROOT**（`nuwax-electron`）决定——脚本只负责
  dispatch，通道由 tag 推导，显式 channel 只校验一致性。
- beta / v*-beta.* 不需要 Windows 人工签名。推送 tag 后，`release-electron-dev.yml` 的五个平台全部构建成功，才自动调用同步工作流；它以 CI 原产 `Nuwax-Setup-<version>-unsigned.exe` 生成 beta 更新元数据，校验来源/哈希、同步 S3/OSS beta 指针，最后公开 GitHub prerelease。用户可直接下载、安装 beta；已选 stable 的客户端仍只读 stable 指针。未签名 MSI 不进入自动更新元数据。
- stable / vX.Y.Z 的兼容入口 `scripts/release-stable.sh X.Y.Z` 默认停在签名阶段；安装验收后用 `npm run release -- --tag vX.Y.Z --stage sync` 同步，核对 stable 指针并提升较旧 beta 指针。beta 发布仅推进 beta 指针。
- 同步产物落到独立通道 `nuwax-electron/`（stable 指针
  `nuwax-electron/latest/latest.json`、beta 指针 `nuwax-electron/beta/latest.json`），
  与社区版 `nuwaclaw-electron/` 互不影响——客户端经
  `NUWAX_UPDATE_FEED_BASE=.../nuwax-electron`（构建期注入）读取。

同步工作流失败后也可手动重试；它会再次核对 Release 状态、对应 tag 的成功构建、五平台来源、Windows 安装包对应渠道的校验和镜像哈希：

```bash
gh workflow run sync-electron-to-oss.yml --repo nuwax-ai/nuwax-client --ref release/v3.0.x \
  -f tag=v<version> -f channel=stable

# beta 重试：
gh workflow run sync-electron-to-oss.yml --repo nuwax-ai/nuwax-client --ref release/v3.0.x \
  -f tag=v<version>-beta.1 -f channel=beta
```

新规范见 [发布与更新通道](./release-channels.md)。stable 默认签名后保持 Draft，真实安装包验收后显式 `--stage sync`。历史 tag 续跑须传原值给 `SIGN_RELEASE_TAG`，不得改历史标签。
