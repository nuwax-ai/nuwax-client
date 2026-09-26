# Nuwax 桌面客户端

**Nuwax（女娲Nuwax）** 是 [nuwax](https://nuwax.com) Agentic AI 平台的官方桌面客户端：把平台的会话、工作空间、资料库、技能与应用开发装进一个原生桌面应用，并在本地叠加桌面专属能力——本机接入（我的电脑）、本地沙箱、多 Agent 引擎、文件服务与自动更新。

- 官网 <https://nuwax.com> · 在线体验 <https://agent.nuwax.com>
- 本仓（[nuwax-client](https://github.com/nuwax-ai/nuwax-client)）产出 macOS / Windows / Linux 安装包，经 `nuwax-electron` 更新通道分发，应用内自动更新。

## 产品能力

### 会话与智能体

- **多引擎**：内置 claude-code / nuwaxcode / codex-cli 三种 Agent 引擎（ACP 协议接入）；运行时依赖首次启动自动初始化，内置优先、缺失时自动下载补齐。
- 会话工作台：会话详情、历史会话、临时分享会话；计划模式与执行过程中的干预/审批确认。
- 会话记忆：核心记忆与完整转录随会话留存。

### 工作空间

- **项目**：常规项目、网页/全栈应用、第三方应用接入三类形态；任务中心与团队设置。
- **资料库**：知识库（含原文对照视图）、数据表格、存储管理。
- **资源生态**：技能、插件、工作流（可视化画布编排）、MCP 管理、模型管理、连接器。
- **应用开发**：应用开发工作台、智能体编辑器；已发布应用可经 OpenApp 形态独立打开。
- **广场与生态市场**：插件/工作流/技能的发现与订阅；女娲应用专区。

### 我的电脑（本机接入）

- 登录后本机自动注册为受管设备（独立设备身份，与平台账号绑定）。
- **工作目录**：默认工作空间 `~/Nuwax`（用户目录下可见、自动创建）；1.0.4 起可在「我的电脑」中选择本机任意目录作为 Agent 工作目录。
- 云端会话经加密隧道访问本机工作目录（lanproxy），远程 Agent 可直接读写指定目录。
- 文件服务：本地文件读写、下载与另存为原子落盘，成功有真实反馈。

### 本地沙箱与执行安全

- 命令级沙箱与权限策略矩阵：macOS Seatbelt、Linux Bubblewrap、Windows Restricted Token（内置原生 helper）。
- 敏感操作执行前浮出审批确认，执行过程可干预。

### 登录与企业版

- 账号密码 / 验证码登录，统一登录页完成。
- **企业登录**：输入企业服务器域名即可接入私有化部署的企业环境（连通性预检后切换重新初始化）。
- 登录态生命周期联动：登录成功自动注册本机并拉起本地服务；登出或凭据失效自动停止全部本地服务。
- 凭据按域隔离存储，切换域名不残留旧环境凭据。

### 桌面体验

- **本地化加载加速**：前端资源随安装包分发、本地伺服，首屏不依赖在线加载；亦可直连线上。
- **自动更新**：stable / beta 双通道，应用内完成。
- 默认简体中文，多语言可切换且实时同步到壳。
- 文件下载、图片另存真实落盘；系统托盘、开机自启、主题与壳同步；`⌘N` 新任务等桌面快捷入口。

## 下载与安装

| 平台 | 产物 | 说明 |
|---|---|---|
| macOS（Apple Silicon / Intel） | `dmg` / `zip` | CI 自动签名 + 公证（1.0.3 起） |
| Windows（x64） | `exe`（NSIS）/ `msi` | NSIS EXE 人工代码签名；MSI 暂未签名，不进自动更新指针 |
| Linux（x64 / arm64） | `AppImage` / `deb` / `rpm` | 随通道分发 |

- **stable 通道**：正式版（`electron-v*` 发版）。
- **beta 通道**：预发布版（`prerelease-v*` 发版），提前体验新功能。
- 更新源（OSS 指针，应用内自动更新同源）：`https://nuwa-packages.oss-rg-china-mainland.aliyuncs.com/nuwax-electron`；安装包获取以官网与企业分发渠道为准。

## 快速上手

1. **登录**：启动客户端，在登录页用账号密码或验证码登录；企业版用户从「企业登录」输入企业服务器域名。
2. **新建会话**：选择引擎与模型，开始对话或下达任务。
3. **接入本机**：登录后本机自动注册；在「我的电脑」中确认/变更 Agent 工作目录（默认 `~/Nuwax`，可选本机任意目录）。
4. **保持最新**：后续版本经应用内自动更新送达，无需手动重装。

## 数据与隔离

- 数据目录 `~/.nuwax`（配置、凭据、本地服务数据）；默认工作空间 `~/Nuwax`（Agent 工作目录）。卸载不主动删除用户数据。
- 与开源社区版 **NuwaClaw** 同源基座、同机可双开互不干扰：

| 维度 | 社区版 NuwaClaw | Nuwax（本产品） |
|---|---|---|
| 应用标识 | com.nuwax-ai.nuwaclaw | com.nuwax-ai.nuwax |
| 数据目录 | ~/.nuwaclaw | ~/.nuwax |
| 本地端口 | 18099 / 60002~60009 / 60173 | 19099 / 61002~61009 / 61173 |
| 更新通道 | nuwaclaw-electron/ | nuwax-electron/ |

品牌与端口为构建期注入（机制见[开发者指南](#开发者指南)），两版互不写对方数据目录。

## 版本历史

详见 [release-notes/](./release-notes/)。近期要点：

- **1.0.4**：web 工作空间选择打通（本机任意目录可作 Agent 工作目录）；登录同步链修复（全新设备首登）；客户端设置入口迁至 web 用户区；Windows 代码签名落地。
- **1.0.3**：登录架构重构（统一登录页、企业登录上线）；默认语言改简体中文；macOS 签名与公证恢复。
- **1.0.0**：由 NuwaWork 更名为 Nuwax，数据目录与更新通道全新开始。

## 术语区分：Nuwax 客户端 vs nuwax 前端（同名不同物）

品牌统一后两者都叫 "nuwax"，但指代完全不同的东西，读代码/沟通时按下表区分：

| | **Nuwax 客户端**（＝**商业版**；本仓产品） | **nuwax 前端**（仓库 [nuwax-ai/nuwax](https://github.com/nuwax-ai/nuwax)，包名 `nuwax-frontend`） |
|---|---|---|
| 是什么 | Electron 桌面应用——「壳」 | React/UMI web 应用——业务 UI 本体 |
| 仓库 | **本仓 nuwax-client**（基座 submodule + overlay 注入身份） | 同一前端仓的三个落位：独立检出 `workspace/nuwax`（mac dev 用）、壳根 `nuwax/` submodule（发布 tag 锁定源码并重建 dist）、线上部署（PC web） |
| 职责 | 窗口/webview 容器 + 桌面能力：登录态桥、本地化承载、沙箱、文件服务、引擎管理、自动更新 | 工作台/会话/资料库等全部页面逻辑 |
| 运行形态 | 安装包分发：productName=`Nuwax`、identifier=`nuwax`、appId=`com.nuwax-ai.nuwax`、数据目录 `~/.nuwax` | ① 浏览器直接访问（PC web，无桥自动降级）；② 客户端窗口内 webview（本地伺服或直连线上） |
| 对外身份 | 注入的 identifier `nuwax` = 宿主产品 id（`x-client-type` 头、桥 `getProduct()`） | 用 `getProduct()`/`isNuwaClaw()` 识别宿主并适配 |

速记：**「Nuwax 客户端」在文档与对话中也称「商业版」**（相对社区版 NuwaClaw）。代码与请求里作为宿主标识出现的 `nuwax` 指客户端宿主；作为仓库名/包名/路径/分支出现的 `nuwax` 指前端项目。

---

## 开发者指南

### 仓库结构

功能模块在基座仓 [nuwa-electron-shell](https://github.com/nuwax-ai/nuwa-electron-shell)，本仓注入商业身份并编排开发、构建和发布。前端源码与客户端资源分别固定版本：

```
nuwax-client/（main = 商业产品壳）
├── nuwa-electron-shell/   # submodule → 基座仓 main 分支（产品中立功能模块）
├── nuwax/                 # submodule → nuwax 前端；发布时从 tag 内 gitlink 源码重建 dist
├── nuwax-dist/            # submodule → public 产物仓 main；本地开发/打包默认消费
├── overlay/               # 商业自有代码（整文件覆写进基座工作树，见下「overlay/」）
├── scripts/client/        # 跨平台统一 CLI：自动准备、前端构建、开发、打包、更新、发布和诊断
├── client.config.mjs      # 非敏感产品身份、端口和发布目标；凭据来自主机登录态/env
├── .github/workflows/     # 发布编排（release / sync）+ 测试门禁（ci.yml 双轨）
├── release-notes/  docs/
└── package.json
```

商业开发线 = 基座仓 main 分支（产品中立，服务 nuwa-cli / nuwaclaw / Nuwax 三方）；本仓差异 = 4 个构建期注入 env（`NUWAX_APP_IDENTIFIER/DISPLAY_NAME/UPDATE_FEED_BASE/PORT_OFFSET`，机制在基座 `constants.ts`，不注入=社区版行为）+ `overlay/` 商业自有代码 + 商业前端 pin。

### 一键开发、前端构建与本地打包

前置安装 Git、Node.js 22 或更新版本，启用 Corepack（或安装对应仓库 `packageManager` 指定的 pnpm）。准备引擎会初始化缺失子模块、同步 overlay，先构建 agent-kit 再安装工作区依赖，重建 Electron 原生模块并准备运行资源。

```bash
git clone https://github.com/nuwax-ai/nuwax-client.git && cd nuwax-client
npm run doctor -- --json
npm run dev
# 前端改动即时生效：
npm run dev -- --frontend source --port 3000
# 单独生成前端生产资源，保留在 nuwax/dist：
npm run frontend:build
# 当前平台无签名商业安装包；源码模式将当前前端改动打入包：
npm run pack
npm run pack -- --frontend source
```

| 命令 | 行为 |
|---|---|
| `npm run frontend:build` | 安装前端依赖并运行 `build:prod`，输出 `nuwax/dist`，报告源码 SHA 与版本戳 |
| `npm run dev` | 自动准备并启动客户端，loopback 网关默认使用 `nuwax-dist` pin |
| `npm run dev -- --frontend source` | 自动准备前端依赖，启动 UMI 热更新、壳 Vite 和 Electron |
| `npm run pack` | 默认使用产物 pin，生成当前平台无签名 Nuwax 包；`--frontend source` 先构建当前前端源码 |
| `npm run sub:update` | 更新源码、构建、提交并推送产物仓、提交外层双 pin |
| `npm run release -- --channel stable --version X.Y.Z` | 编排 CI、Windows 签名机和正式发布；支持 `--channel beta` |
| `npm run doctor -- --json` | 只读报告环境、依赖、资源和 pin 就绪状态 |

缓存位于 `.cache/client-toolchain/`，按锁文件、包管理器、agent-kit 内容、Electron ABI、平台及架构失效。再次开发会复用有效依赖、原生模块和运行资源，保留 Vite 缓存。`dev`、`pack`、`frontend:build` 支持 `--dry-run`；`dev`、`pack` 支持 `--refresh-resources`，显式刷新源码型资源来源。工具链在自有缓存中构建这些资源，保留基座 `sources/` 中的开发改动。

首次接入时，若 `resources/nuwax-file-server` 或 `resources/claude-code-acp-ts` 已存在普通旧产物，脚本会在新资源构建成功后将原目录移到 `.cache/client-toolchain/legacy-resources/<name>-<UUID>/` 并报告备份路径。资源目录中的 Git 检出、工具链产物中的本地修改仍会阻止覆盖；后续只更新归属明确且内容未被修改的产物。

开发会检查占用端口、等待 HTTP 就绪，记录 `logs/frontend-dev.log`（源码模式）、`logs/vite-dev.log` 和 `logs/electron-dev.log`，退出时清理本轮启动的进程树。本机服务与主进程的完整日志仍在 `~/.nuwax/logs/`。已有前端源码改动请用 `--frontend source`；默认 dist 模式要求当前源码、产物 HEAD 与已提交双 pin 一致。

本地打包使用独立商业配置，输出到 `release/<version>/`；默认版本来自最近可达的发布 tag 并加 `-dev`，无 tag 时用 `0.0.0-dev`。可用 `--version X.Y.Z`、`--output <目录>` 覆盖，`--dir` 只生成解包应用目录；输出目标不得占用仓库根、源码/子模块目录或工具链缓存，符号链接也会核对真实目标。配置不改基座 `package.json`，包含商业品牌、前端载荷及 Computer Use helper，不发布资产。

Windows 可以在 PowerShell 或 cmd 中直接运行以上 npm 命令，无需 make。准备 Windows 沙箱 helper 需要 Rust/Cargo 与 MSVC 构建工具；Electron 原生模块需要相应的 Python/C++ 构建环境。打包 Computer Use helper 还需要 Rust/rustup（Windows 使用已准备的 Git Bash；Linux 需平台构建依赖）。缺失工具或真实资源时脚本会退出并报告原因。

旧入口 `base:dev`、`base:bundle` 转发到统一 CLI。`make dev DEV_WEBVIEW=dev FRONTEND_PORT=3001` 等价于 `npm run dev -- --frontend source --port 3001`；`make submodules-latest` 转发 `sub:update`。`make submodules` 可显式将三个子模块对齐已提交 pin；普通开发只初始化缺失子模块。

### 子模块一键更新

```bash
npm run sub:update
npm run sub:update -- --nuwax feat-2026.9.30
npm run sub:update -- --nuwax <branch-or-tag-or-sha> --shell <ref> --push
```

完整链为：拉取源码 → 构建 `nuwax/dist` → 校验版本戳 → 刷新 [nuwax-ai/nuwax-dist](https://github.com/nuwax-ai/nuwax-dist) → 提交并推送产物 `main` → 提交外层 `nuwax`、`nuwax-dist` 双 gitlink（以及有变化的基座 pin）。产物仓根 README 保留，所有仍被客户端 pin 引用的提交保留历史。

`nuwax/dist` 是本地暂存，不提交进前端源码仓。独立 `frontend:build` 会保留它；更新器完成或失败后清理本轮构建暂存和生成版本文件。源码改动、已有待推产物提交和无关暂存文件都会受到保护。

更新参数：`--no-build` 仅复用与目标源码 SHA 匹配的产物；`--force-build` 强制构建；`--with-test` 增加商业测试；`--no-commit` 全链跳过提交与推送，不能搭配 `--push`；`--no-push-dist` 留本地产物提交；`--push` 推送外层当前分支。`--force` 只放宽外层无关 WIP 检查，不绕过覆盖或远端可达性保护。推送不强推；产物远端竞争最多重做一次，其他情况失败后按提示处理再重跑。

### 分支模型与双轨门禁

**单主干**：两仓均为 `feat/* 开发线 → PR → main → tag 发布`；基座 pin 跟随基座 main（`.gitmodules` branch=main），历史 `pin/nuwawork` 线已退役。发布由 tag 驱动（`electron-v*` / `prerelease-v*`），main 不直接发布。`main` 与 `release/**` 的 PR/push、发布 tag 均运行源码门禁。分支命名的权威规范见 [docs/branch-naming.md](./docs/branch-naming.md)，本节仅摘要。

| 门禁 | 命令 | 口径 | CI |
|---|---|---|---|
| 社区基线 | `npm run base:test` | `--no-inject`：干净基座 + 社区默认值（会还原工作树 overlay） | ci.yml · community job |
| 商业门禁 | `npm run test:commercial` | `--no-env`：同步 overlay、不注 env，全量 vitest | ci.yml · commercial job |
| 守卫自测 | `npm run test:scripts` | pin、overlay、来源清单及本地诊断用例 | ci.yml · commercial job |
| 前端源码 | `pnpm -C nuwax exec vitest run`、`pnpm -C nuwax lint:arch` | tag 锁定的前端源码 | ci.yml · frontend job |

`base:test` 会把 overlay 产物清出基座工作树，须在隔离副本运行；商业门禁另行同步 overlay 执行。脚本测试、商业测试和真实安装包验收分别报告。

### 与基座 / 社区版 / 前端的同步

- **提交基座**：中立改动在 nuwa-electron-shell 内 feat 线经 PR 进 main（勿 rebase 改写已 pin 的 SHA）→ 本仓 `npm run check:pin`（基座脏文件/staged 不得混入 overlay 托管路径，CI 另有 `--remote origin/main` 字节级防线）→ bump submodule pin → `npm run overlay:check` 核对覆写差异 → `npm run test:commercial`。
- **社区版**：社区产品壳与商业版同源基座、各自独立发布，互不影响。
- **壳根 nuwax 双 pin**：`nuwax/` 固定前端源码，`nuwax-dist/` 固定对应机器生成资源；升级使用 `sub:update` 一起刷新。源码提交须在 `.gitmodules` 声明分支上可达，产物仓只使用 `main`。phase 1 的正式版与 beta CI 保持从 tag 内 `nuwax/` gitlink 现场重建、校验 `dist/version.json`，再将 `nuwax/dist` 打入安装包；CI 尚不消费产物 pin，来源清单仍读取现场构建目录。工作区已有 dist 不代表发布包内容。

### 发版流程

先运行只读预检，再用同一入口发布或续跑：

```bash
npm run release -- --channel stable --version X.Y.Z --dry-run
npm run release -- --channel stable --version X.Y.Z
npm run release -- --channel beta --version X.Y.Z --dry-run
```

发布入口验证已提交说明文件、版本/tag、外层目标 SHA 与子模块远端可达性，跟踪相同 tag/SHA 的 CI run；失败后重跑会根据远端状态继续。stable 的 Windows 签名使用 `client.config.mjs` 中的签名机配置；Certum SimplySign 手机认证由人工完成，认证后可续跑。收口检查签名、S3/OSS 资产哈希、更新指针和 GitHub Release 公开状态。

1. 提交 `release-notes/electron-v{x.y.z}.md`（beta 使用 `release-notes/prerelease-v{x.y.z}.md`）。
2. `git tag electron-v{x.y.z} && git push origin electron-v{x.y.z}` → `release-electron.yml`：先跑双轨与前端门禁，再从锁定的 gitlink 构建前端和五平台安装包，产物先留在 Draft Release；每个平台上传源码与产物摘要清单。macOS 必须签名、公证并完成运行时验证，Windows 初始产出 unsigned 包。
3. Windows 人工签名：[docs/sign-windows.md](./docs/sign-windows.md)（Certum SimplySign + 基座内 `npm run sign:win`）。
4. 调用独立的 `sync-electron-to-oss.yml`：先核对五平台清单和签名版 Windows EXE，再同步资产、更新 stable 指针并公开 Release；失败以红灯呈现。`scripts/release-stable.sh` 编排上述步骤。

beta 通道：`prerelease-v{x.y.z}` tag 的五平台构建全部成功后，`release-electron-dev.yml` 自动调用同步工作流，以 CI 原产未签名 Windows EXE 生成 beta 更新元数据，校验来源和哈希，更新 S3/OSS beta 指针，并公开 GitHub prerelease。用户可直接下载安装；客户端是否接收 beta 只由更新通道设置决定。正式版由 `scripts/release-stable.sh` 人工签名后独立同步 stable，beta 不改 stable 指针。验收字段见 [发布验收模板](./docs/release-acceptance-template.md)，维护规则见 [工程维护](./docs/maintenance.md)。

维护人员可在故障机器上运行 `npm run diagnostics:export -- --output <path>` 导出本地诊断 JSON。它只记录日志级别、组件和错误码统计，以及固定端口连通性；不包含日志正文、凭据或远程上报。

### 首次启用清单（人工操作）

- [ ] GitHub Settings → Secrets（与社区版同值，共用证书）：`GH_PAT`（可选）+ Apple 签名/公证族（`APPLE_TEAM_ID` 等）+ `MINIO_*` + `OSS_*`
- [ ] 打首个 `prerelease-v*` tag 验证构建链路；平时可用 `ci-smoke.yml`（workflow_dispatch）快速回归 submodule 链路
- [ ] Windows 签名机按 docs/sign-windows.md 完成一次 sign:win 演练
- [ ] 验证 OSS `nuwax-electron/` 指针与社区版 `nuwaclaw-electron/` 互不影响

### overlay/ —— 商业自有代码（文件覆写机制）

商业专属实现不进基座（基座产品中立，服务三方），放在 `overlay/` 下按基座相对路径组织，构建/开发前由 `scripts/sync-overlay.js` 整文件覆写进基座工作树（统一 CLI 与 CI 已自动前置同步；`--check` 干跑核对、`--clean` 还原）。准备引擎拒绝覆盖未被本轮工具链管理的基座本地改动。机制与纪律详见 [overlay/README.md](./overlay/README.md)。
