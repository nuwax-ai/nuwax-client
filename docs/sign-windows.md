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
4. 壳仓 clone + submodule 初始化（见 README「本地开发」）；本地运行基座脚本前
   先 `npm run base:install`（会同步 overlay 覆写基座工作树）。

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

## SSH 远程代跑（2026-09-15 起，一条龙编排）

签名步骤可从 mac 经 ssh 在签名机（`win-pc`）上代跑，全程编排在
`scripts/release-stable.sh`（tag → CI → 远程签名 → stable 同步 → 验证，断点续跑），
无需人工上机敲命令。人工前置只剩一件：**SimplySign Desktop 登录（手机 2FA）**。
签名后重跑时，Release 仅有签名版 EXE 也会通过资产前置检查；`--notes` 允许
指定说明文件尚未提交，脚本会先单独提交并推送它。

签名与同步需要分开跑时（跨天发版、签名机现场直签后回 mac 同步等场景）用
`--stage` 拆开，两个阶段各自携带完整前置校验、可独立续跑：

```bash
npm run release -- --channel stable --version X.Y.Z --stage sign   # 只到签名资产就位
npm run release -- --channel stable --version X.Y.Z --stage sync   # 只 dispatch 同步 + 镜像验证
```

`--stage sync` 在 stable 缺签名资产时会拒绝并提示先跑 `--stage sign`；beta 无签名
阶段，`--stage sign` 不适用。

win-pc 一次性配置记录（已做，勿重复）：

- `winget install GitHub.cli` + `gh auth login`（mac 侧 `gh auth token | ssh win-pc "bash -lc 'gh auth login --with-token'"` 管道，token 不落日志）；
- `WINDOWS_CERTIFICATE_SHA1` 在 `~/.bashrc`；signtool 用 Windows Kits 自带（`.../Windows Kits/10/bin/*/x64/signtool.exe`）；
- **sshd 会话 PATH 不含 MSI 装的 gh**（新开 ssh 会话拿旧环境），调用时须显式
  `export PATH="/c/Program Files/GitHub CLI:$PATH"`——编排脚本已内置。

### 签名机上本地直签（续签/排查用）

正常发版无需上机（mac 侧 `npm run release` SSH 编排同款命令）。SSH 链路不可用或需要
现场排查时，在签名机上按同一口径直跑：

```bash
cd /c/soddy-git-workspace/nuwax-client
tag=v<version>                       # 例 v3.0.10
git fetch origin "refs/tags/$tag"
sha=$(git rev-parse "FETCH_HEAD^{commit}")
work=../.nuwax-release-$tag-${sha:0:12}
git worktree add --detach "$work" "$sha" 2>/dev/null || true   # 已存在时复用
cd "$work"
shellurl=$(git config --file .gitmodules --get submodule.nuwa-electron-shell.url)
git -c "submodule.nuwa-electron-shell.url=$shellurl" submodule update --init nuwa-electron-shell
node scripts/sync-overlay.js
cd nuwa-electron-shell/crates/agent-electron-client
SIGN_RELEASE_TAG="$tag" SIGN_RELEASE_REPO=nuwax-ai/nuwax-client \
SIGN_WORK_DIR=/c/tmp/nuwax-sign/$tag-${sha:0:12} \
SIGN_WIN_ARTIFACT_PREFIX=Nuwax SIGN_SKIP_BLOCKMAP=true \
npm run sign:win -- <version>
```

要点：

- **重跑免重下**：draft 期间远端 digest 查询受限，签名脚本缓存校验拿不到哈希会整包
  重下（~731MB）。SimplySign 2FA 超时重试时，若 `SIGN_WORK_DIR/unsigned/` 已有完整
  unsigned EXE 且其 SHA256 与 Release 上 `build-manifest-windows-x64.json` 记录一致，
  追加 `--skip-download` 续跑（`release` 编排已内置此判定）。
- 签名留档在 `SIGN_WORK_DIR/signed/`（每版 unsigned+signed ~1.5GB，无人自动清理，
  需要时手动清旧 tag 目录）。
- 编排脚本在签名成功后会自动清理其他 `.nuwax-release-*` 一次性 worktree（其他 tag
  与旧命名后缀）；手动直签场景须自行 `git worktree remove`。

已知取舍：v2 签名脚本默认 `SIGN_SKIP_BLOCKMAP=true`，签名版 EXE 不重生成 blockmap，
Windows 自动更新走全量下载（非差分）；需要差分时在签名机上手动生成并补传。

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

- `SYNC_OSS_REF` 应填目标发布线分支（示例为 `release/v3.0.x`），并确认该分支含与发布 tag 相同的来源校验 workflow。脚本在基座目录运行时不可依赖其默认 ref。
- 通道根由**壳仓 workflow 的 RELEASE_ROOT**（`nuwax-electron`）决定——脚本只负责
  dispatch，通道由 tag 推导，显式 channel 只校验一致性。
- beta / v*-beta.* 不需要 Windows 人工签名。推送 tag 后，`release-electron-dev.yml` 的五个平台全部构建成功，才自动调用同步工作流；它以 CI 原产 `Nuwax-Setup-<version>-unsigned.exe` 生成 beta 更新元数据，校验来源/哈希、同步 S3/OSS beta 指针，最后公开 GitHub prerelease。用户可直接下载、安装 beta；已选 stable 的客户端仍只读 stable 指针。未签名 MSI 不进入自动更新元数据。
- stable / vX.Y.Z 由 `scripts/release-stable.sh x.y.z` 单独触发 stable 通道，并核对 S3/OSS 两侧 stable 指针；beta tag 不会触发 stable 同步。
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
