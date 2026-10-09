# npm 脚本参考（外层仓 + 基座 crate）

两层 `package.json` 各管一摊：**外层仓**（nuwax-client）是日常开发/发版入口，全部经
`scripts/client/cli.mjs` 状态机统一编排；**基座 crate**
（`nuwa-electron-shell/crates/agent-electron-client`）是产品中立的功能模块，承载签名、
electron-builder 打包与运行资源准备。本页是完整清单；日常速查见 README
「一键开发、前端构建与本地打包」，Windows 签名 runbook 见
[sign-windows.md](./sign-windows.md)。

## 外层仓 `nuwax-client/package.json`

统一 CLI 入口（`node scripts/client/cli.mjs <action>`）：

| 命令 | 行为 |
|---|---|
| `npm run setup` / `base:install` | 准备引擎：初始化缺失子模块、同步 overlay、构建 agent-kit、装依赖、重编原生模块、准备运行资源 |
| `npm run dev` / `base:dev` | 自动准备并启动客户端；`--frontend source` 走前端源码热更新，`--port` 指定 UMI 端口 |
| `npm run pack` / `base:bundle` | 当前平台无签名商业包；`--frontend source` 将当前前端源码改动打入包 |
| `npm run frontend:build` | 安装前端依赖并构建，输出保留在 `nuwax/dist` |
| `npm run sub:update` | 子模块一键更新：拉源码 → 构建 dist → 推产物仓 → 提交外层双 pin |
| `npm run release` | `--version X.Y.Z` 或 `X.Y.Z-beta.N` 推导通道，`--channel` 仅校验，`--dry-run` 预检。stable 默认完成签名后保留 Draft，安装验收后显式 `--stage sync`；beta 五平台成功后自动同步公开。`--tag` 以当前工具续跑历史 tag/SHA |
| `npm run sign:win -- <版本>` | 转发基座签名脚本（`scripts/client/forward.mjs` 自动注入 `SIGN_RELEASE_REPO`/`SIGN_WIN_ARTIFACT_PREFIX=Nuwax`）；手动兜底用，正常发版走 `release` |
| `npm run verify:sign:win` | 转发基座本地验签 |
| `npm run sync:oss -- <tag> <stable\|beta>` | 转发基座 OSS 同步（自动注入 `SYNC_OSS_REPO`、`SYNC_OSS_REF=当前分支`）；手动兜底用 |
| `npm run doctor` | 只读报告环境/依赖/资源/pin 就绪状态，`--json` 机读 |

门禁与治理：

| 命令 | 行为 |
|---|---|
| `npm run base:test` | 社区基线（`--no-inject`：会清 overlay，须在隔离副本跑） |
| `npm run test:commercial` | 商业门禁（`--no-env`：同步 overlay 不注 env，全量 vitest） |
| `npm run test:scripts` | `node --test scripts/*.test.mjs`，守卫脚本自测 |
| `npm run check:pin` | 基座脏文件/staged 不得混入 overlay 托管路径（提交基座前必跑） |
| `npm run overlay:sync` / `overlay:check` / `overlay:clean` | overlay 单向覆写的执行 / 核对 / 还原 |

杂项：`in-base`（在基座目录代跑命令，`base:test`/`test:commercial` 的底座）、
`diagnostics:export`（导出诊断包）。`release-stable.sh` 是 `npm run release -- --channel
stable` 的兼容壳，真身在 `scripts/client/release.mjs`。`sign:win`/`verify:sign:win`/`sync:oss`
经 `scripts/client/forward.mjs` 转发：cwd 落基座 crate 并注入商业发布 env（外层同名 env
优先），参数原样透传；常规签名由 `release` 编排；stable 安装验收完成后，仍须显式运行 `release --tag <原 tag> --stage sync`。

## 基座 crate `agent-electron-client/package.json`

### 签名与发版

| 命令 | 行为 |
|---|---|
| `npm run sign:win` | Windows 签名主入口（`sign-release-win-v2.sh`）：下载 unsigned EXE → signtool（指纹 + RFC3161 时间戳）→ 验签 → 上传 `Nuwax.Setup.{v}.exe`。**只跑在签名机 win-pc 上**，由外层 `npm run release` 经 SSH 触发；商业版须带 `SIGN_WIN_ARTIFACT_PREFIX=Nuwax` |
| `npm run sign:win:v1` | 旧版逐文件下载流程，留作回退 |
| `npm run verify:sign:win` | 本地验签 Windows 产物 |
| `npm run verify:sign` | mac 产物验签 |
| `npm run sync:oss` | 手动同步 OSS 的兜底入口（stable 常规路径由 release 状态机 dispatch workflow 完成） |

签名链路：外层 `npm run release -- --version X.Y.Z --stage sign` 校验目标 tag/SHA 与五平台来源，读取当前自动化提交 pin 的基座签名工具，通过 SSH stdin 交给 win-pc。Windows 只下载/核验缓存 → 签名/验签 → 上传，不需要源码、子模块、overlay 或 npm 安装；上传成功才删除 unsigned 资产。证书为 Certum SimplySign，手机 2FA 由人工完成。详见 [sign-windows.md](./sign-windows.md)。

版本策略由 `scripts/release-version.mjs` 共用；`scripts/client/release.mjs` 编排不可变 tag、同 tag/SHA Actions、签名及最终校验；`scripts/release-provenance.mjs` 校验独立目标源码；`scripts/publish-release-pointers.mjs` 管理双镜像指针备份、SemVer 防回退、回读与失败回滚。CI 路由见 [发布与更新通道](./release-channels.md)。

### 构建与打包

| 命令 | 行为 |
|---|---|
| `npm run build` | `build:main`（esbuild 主进程）+ `build:renderer`（vite） |
| `npm run build:electron` | build + electron-builder（CI 五平台矩阵即此入口） |
| `npm run dist:mac[:arm64\|:x64\|:unsigned*]` | mac 各架构打包；`unsigned` 系列置空签名身份出无签名包 |
| `npm run dist:win[:x64\|:arm64]` / `dist:linux[:x64\|:arm64]` | 对应平台打包 |
| `npm run dist:unsigned:local` | 当前平台无签名本地包（外层 `npm run pack` 的基座侧实现） |
| `npm run clean:release` / `clean:electron-cache` | 清 `release/` 与 Electron 构建缓存 |

### 开发

| 命令 | 行为 |
|---|---|
| `npm run dev` | ensure-resources → vite 与 electron 并行（基座直跑即社区版形态；商业开发用外层 `npm run dev`） |
| `npm run dev:vite` / `dev:electron` | 分跑渲染层 / 等待 vite 后起主进程 |
| `npm run build:main(:dev)` | 主进程 esbuild（生产/开发） |

### 运行资源准备（prepare:* 族）

`npm run prepare:all` 总入口；单项按需：`prepare:uv`、`prepare:sign-uv`（mac 侧签 uv
二进制）、`prepare:lanproxy`、`prepare:ttyd`、`prepare:node`、`prepare:git`、
`prepare:ripgrep`、`prepare:mcp-proxy`、`prepare:sandboxed-mcp`（配套
`verify:sandboxed-mcp`）、`prepare:nuwaxcode`、`prepare:codex-acp-ts`、
`prepare:claude-code-acp-ts`、`prepare:nuwax-file-server`。商业版跳过社区旧
`prepare:gui-server`、`prepare:windows-mcp` 和沙箱准备项，computer use 仅使用 CUA helper。
社区基座还提供 `prepare:sandbox-runtime`、`build:sandbox-helper` /
`prepare:sandbox-helper-win`、`electron-rebuild`（重编 better-sqlite3）。产物落
`resources/`，缓存与覆盖规则见 README「缓存」段。
商业版外层 `prepare` 和发布 CI 跳过旧沙箱 helper、runtime、sandboxed MCP；
上述沙箱脚本仍供基座社区版使用。

### 测试与检查

`test(:run/:coverage)`、`test:scripts`、`test:integrated-node`、
`sandbox:matrix:check|generate`（沙箱矩阵一致性）、`check:boundaries`（import 边界）、
`check:appdir`（应用目录字面量）、`check-ports(:dev)`（启动端口检查）、`lint(:fix)`。

S3 上传验证由 `scripts/release-storage-integrity.mjs` 共用于 Actions 与 CLI：新资产优先服务端 SHA256/大小，缺少校验值时限四路完整回读；逐文件打印方式与耗时。`s3Checksums` 是可选来源记录，旧 tag 不要求补写。GitHub 只读轮询遇到 EOF、连接超时或 502/503/504 时最多重试两次，发布写操作不会因此重复执行。
