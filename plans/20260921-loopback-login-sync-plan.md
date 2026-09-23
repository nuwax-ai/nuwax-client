# 实施计划：loopback 登录态 header 通道与资源路由

- 初稿 2026-09-21，评审修订 2026-09-22；用户已授权独立 worktree 实施。
- 需求：`plans/20260922-loopback-login-sync-intent.md`。
- 规范性方案：`specs/loopback-login-sync-header-channel.md`。
- 历史调研：`docs/20260921-loopback-login-sync-research.md`，原全量 namespace/仅网关剥 cookie 方案以本次修订为准。

## WS1：网关

落点 overlay loopbackGateway/gateway.ts、index.ts 与测试。

1. HTTP/WS 出口剥 ticket，保留其他 cookie；公共登录路径不代注旧 Bearer。存储的 Bearer 只代注给主进程确认的受信网关请求，外站直接访问本地网关不借凭据。
2. 当前后端专用 namespace，目标严格校验；query/Referer/同后端资源重定向保持语义。
3. 文档保持 pathname；绝对业务域资源与已登记微应用 frame 的相对资源归上游；主 SPA 静态保留本地。
4. 保留微应用前缀，新文档根显式登记。

## WS2：会话鉴权与注册

落点 overlay sessionAuthInjection、共享规则、nuwaxBridgeHandlers/commercialAuth、preload 与测试。

1. 单 listener，保留 x-client-type，显式 HTTP(S)/WS(S)，按 origin 与可信 frame 注入；受信网关 HTTP/WS 请求附主进程 capability，伪造头先剥除。
2. 普通 renderer 业务出口总剥 ticket；主进程显式注册配对 ticket 例外。
3. token 替换先撤旧代次；cookie 捕获跨 await 核对 generation/origin/token；拒绝旧 jar 写回与迟到失效。
4. auth:getContext/preload 契约；独立窗业务 URL 路径保持式映射 gateway。

## WS3：前端

独立 nuwax 检出从外层 pin df987b3b9 开始，不使用原工作区 dirty HEAD/dist。

1. hostBridge.auth.getContext 与可降级导航助手；四个鉴权导航入口接入。
2. 结算去测试域硬编码、全形态 Bearer、401/4010/4011 停轮询。
3. 单测通过后 pnpm run build:prod；核对生成版本和产物，再 git add -f dist。不使用无效的 git add --no-verify，不默认跳过提交门禁。

## WS4：验证与交付

1. 模块针对性测试 → 商业 npm run test:commercial。
2. 社区 npm run base:test 在另一隔离副本执行（会清 overlay，不能和实施共用副本）。
3. overlay --check、check:pin、前端测试/生产构建。
4. Electron 本地 HTTP/WS 夹具使用临时 profile，不读取真实用户凭据。
5. 按规格 V1–V10 验证；真实后端/支付/macOS/Windows 安装包另列证据。
6. 前端独立提交，再外层更新 pin 并提交 overlay/文档；无商业基座提交，不自动推送/合并/发版。

## 顺序与放行

WS1–3 可并行，共享接口先对齐。网关和 direct ticket 治理必须同批验收，不能单做 WS1 就称单通道闭环。

自动化通过不等于后端契约已确认。若实际端点不支持 Bearer-only、ticket 非恒等或有静默续期，发布前须补契约/策略，不可仅记录日志后宣称兼容。

## 验证记录

2026-09-22，本批 worktree 实测（外层基线 4562cdb4、基座 f59f1bbe）：

- 定向（loopbackGateway/routingPolicy/sessionAuthInjection/commercialAuth/tokenScopes）：129 passed。
- `npm run test:commercial`：129 文件 passed / 1 skipped，**1602 passed / 18 skipped**，exit 0。
- 社区基线 `npm run base:test`（`git clone --shared` 隔离副本、基座 detach f59f1bbe、node_modules 软链、补齐 mcp-proxy-ts 测试资源）：116 文件 passed / 1 skipped，**1381 passed / 18 skipped**，exit 0。末批改动仅 overlay/前端/脚本，不影响 base:test 加载面。
- `node scripts/sync-overlay.js --check`：0 待同步（48 一致）；`npm run check:pin`：基座脏 48 个全部为 overlay 同步产物，通过。
- 前端（nuwax 源码尖 93d47497b）：authNavigation/hostBridge/paymentSettlement 定向 **76 passed**；`pnpm run build:prod` 后 dist 随 `b43b8d266` 提交（version.ts APP_GIT_HASH=93d47497b，结算页测试域硬编码已清）。
- 真实 Electron 夹具 `node scripts/acceptance/loopback-login-sync.cjs`（electron 40.8.2，临时 profile + 虚构 token，本地 HTTP/WS 上游）：direct 合同（业务头/公共登录不代注/主进程注册配对 ticket/WS/外站不注入）与 gateway 合同（HTTP/WS 代注与剥 ticket、iframe 绝对/根相对/目录相对资源、CSS/module 依赖、资源 302、`Origin: null` 能力头路径）均 **PASS**。
- 未覆盖（发布前另行取证）：真实后端 Bearer-only/ticket 轮换契约、真实支付链路、macOS/Windows 安装包手动矩阵（规格 V1–V10）。

### 2026-09-23：合并 release 后的提测复核

- 外层 `codex/loopback-login-sync` 合入 `origin/release/v1.0.x@73b1ecf9`（外层合并提交 `a9552273`），基座 pin 更新至 `aa50bb78`。旧版同名 spec 的 add/add 冲突采用本分支已评审、与实现对应的版本。
- 前端以 `8f0398e20` 为 release 基线合并登录改动：源码合并提交 `32aef9037` 同时保留 `auth.getContext` 和新版桌面预览桥；重新构建的 dist 提交 `d19a0208c`，`dist/version.json` 与 `src/constants/version.ts` 的源码戳均为 `32aef9037`。生成的 dist 不能用两边的旧 chunk 拼接。
- 商业轨 `npm run test:commercial`：129 文件通过 / 1 跳过，**1612 通过 / 18 跳过**。社区轨在隔离副本对基座 pin `aa50bb78` 跑 `npm run base:test`：116 文件通过 / 1 跳过，**1391 通过 / 18 跳过**。
- 前端合并点 `authNavigation`、`hostBridge`、`desktopShellPreview`、结算页四组 **83 测试通过**；`pnpm run build:prod` 通过。真实 Electron 40.8.2 临时 profile 夹具两段 PASS（direct、gateway，25 请求）。`sync-overlay --check` 仍是 48 文件一致，`check:pin` 通过。
- 三问自查：鉴权头策略集中在 `sessionAuthInjection.ts` / `auth/requestPolicy.ts`，网关路由集中在 `loopbackGateway/routingPolicy.ts`；主进程只经 IPC/preload 暴露鉴权上下文，前端导航统一走 `authNavigation.ts`；关键边界有命名规则、文档和定向测试。新基座的 loading / 构建改动不在这 48 个 overlay 托管路径内。
- 待提测环境验证：真实后端 Bearer-only 与 ticket 轮换契约、真实支付回跳、macOS/Windows 安装包登录与 V1–V10 手动矩阵。自动化与临时 profile 夹具不代表这些结果。
- 质量自查补修：网关原先只用 capability 决定 opaque CORS 回包，却仍为外站直接访问网关的请求代补 Bearer。现改为 capability 同时约束网关 HTTP/WS 的存储凭据代注；Electron 的 WS `ws:` 目标按 `http:` 网关 origin 等价匹配。商业轨复跑 **1614 通过 / 18 跳过**；真实 Electron 夹具增加外站 HTTP/WS，**27 请求 PASS**。
- 本地 `npm run base:bundle` 已完成依赖准备与 Electron 源码构建，但 electron-builder 在完整打包时报 `.../crates/agent-electron-client not a file`；以 `--dir` 重跑可生成应用目录，但仍是基座默认的 `NuwaClaw.app` 身份。两者都不算商业 Nuwax 安装包验收；须用 CI 同款产品标识、前端 dist 注入和签名流程复验。

### 2026-09-23：本机开发版界面复核（`feat-2026.9.30`）

- 前端登录改动合入 `feat-2026.9.30`，源码提交 `c32881b24`；83 项定向测试通过，`pnpm run build:prod` 通过，`e5461eb0c` 提交的 `dist/version.json` 标明源码戳 `c32881b24`。外层 `release/v1.0.x` 的 gitlink 与 `.gitmodules` 指向该分支及提交。
- 本机 Electron 40.8.2 开发版使用 `NUWAX_LOOPBACK_DIST=1` 启动；日志确认回环网关 `127.0.0.1:46800` 加载壳根 `nuwax/dist`，业务服务进入 ready。网关 `/version.json` 返回 `c32881b24`，`/home` 返回 200。
- 已登录账户的客户端窗口实际显示 `/home`；点击“消息”后，`/instant-message/` 微应用在回环 origin 下加载会话列表；点击“资料库”后，`/repo/` 微应用在同一 origin 下加载目录和文档列表；返回主页仍保持登录态。随后在客户端设置关闭“本地化加速”，确认加载源切到 `https://testagent.xspaceagi.com`，主页、消息和资料库在直连形态也保持登录并加载数据；重新打开开关后回到 `127.0.0.1:46800/home`，登录态仍在。未执行退出登录或真实支付交易。
- 同一工作树复跑 `npm run test:commercial`：129 文件通过 / 1 跳过，1614 通过 / 18 跳过；Electron 临时 profile 的登录态 HTTP/WS 夹具 27 请求 PASS。完整重新登录、真实后端 ticket 轮换、支付回跳及商业安装包仍需独立验收。
- 本机已有一个先前启动的 renderer Vite 进程占用 61173，新 dev 命令的 Vite 子进程报端口占用；本轮 Electron 主进程与网关为新启动，renderer 页面由同一源码目录的既有 Vite 进程提供。因此不能将本轮记录视为全新 renderer 进程的独立冷启动验收。
