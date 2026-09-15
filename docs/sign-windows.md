# Nuwax 商业版 — Windows 人工签名 Runbook（Certum SimplySign）

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

## 发版流程（每次）

CI 在 nuwax-client 打 `electron-v{v}` tag 后产出**未签名**产物
`Nuwax-Setup-{v}-unsigned.exe`（以及最终名 MSI，不签名）。

```bash
cd <nuwax-client 检出>/nuwa-electron-shell/crates/agent-electron-client

SIGN_RELEASE_REPO=nuwax-ai/nuwax-client \
SIGN_WORK_DIR=/c/tmp/nuwax-sign \
SIGN_WIN_ARTIFACT_PREFIX="Nuwax" \
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
- 排障（Release 资产名对照、gh 找不到等）见基座 windows-signing.md 同名章节。

## SSH 远程代跑（2026-09-15 起，一条龙编排）

签名步骤可从 mac 经 ssh 在签名机（`win-pc`）上代跑，全程编排在
`scripts/release-stable.sh`（tag → CI → 远程签名 → stable 同步 → 验证，断点续跑），
无需人工上机敲命令。人工前置只剩一件：**SimplySign Desktop 登录（手机 2FA）**。

win-pc 一次性配置记录（已做，勿重复）：

- `winget install GitHub.cli` + `gh auth login`（mac 侧 `gh auth token | ssh win-pc "bash -lc 'gh auth login --with-token'"` 管道，token 不落日志）；
- `WINDOWS_CERTIFICATE_SHA1` 在 `~/.bashrc`；signtool 用 Windows Kits 自带（`.../Windows Kits/10/bin/*/x64/signtool.exe`）；
- **sshd 会话 PATH 不含 MSI 装的 gh**（新开 ssh 会话拿旧环境），调用时须显式
  `export PATH="/c/Program Files/GitHub CLI:$PATH"`——编排脚本已内置。

已知取舍：v2 签名脚本默认 `SIGN_SKIP_BLOCKMAP=true`，签名版 EXE 不重生成 blockmap，
Windows 自动更新走全量下载（非差分）；需要差分时在签名机上手动生成并补传。

## 同步 OSS（stable 须先完成上面签名）

```bash
cd <nuwax-client 检出>/nuwa-electron-shell/crates/agent-electron-client

SYNC_OSS_REPO=nuwax-ai/nuwax-client \
SYNC_OSS_REF=main \
npm run sync:oss -- electron-v<version> [stable|beta]
```

- `SYNC_OSS_REF=main`：dispatch 的 workflow 定义在壳仓 main（脚本在基座目录里运行时
  ref 解析会落到基座分支，必须显式覆盖）。
- 通道根由**壳仓 workflow 的 RELEASE_ROOT**（`nuwax-electron`）决定——脚本只负责
  dispatch，不接收通道参数，无需也无法在此覆盖。
- beta / prerelease-v* 不要求签名，可直接 sync。
- 同步产物落到独立通道 `nuwax-electron/`（stable 指针
  `nuwax-electron/latest/latest.json`、beta 指针 `nuwax-electron/beta/latest.json`），
  与社区版 `nuwaclaw-electron/` 互不影响——客户端经
  `NUWAX_UPDATE_FEED_BASE=.../nuwax-electron`（构建期注入）读取。

等价的手动触发方式（不依赖脚本）：

```bash
gh workflow run sync-electron-to-oss.yml --repo nuwax-ai/nuwax-client --ref main \
  -f tag=electron-v<version> -f channel=stable
```
