# 实施计划：loopback 登录态 header 通道与资源路由

- 初稿 2026-09-21，评审修订 2026-09-22；用户已授权独立 worktree 实施。
- 需求：`plans/20260922-loopback-login-sync-intent.md`。
- 规范性方案：`specs/loopback-login-sync-header-channel.md`。
- 历史调研：`docs/20260921-loopback-login-sync-research.md`，原全量 namespace/仅网关剥 cookie 方案以本次修订为准。

## WS1：网关

落点 overlay loopbackGateway/gateway.ts、index.ts 与测试。

1. HTTP/WS 出口剥 ticket，保留其他 cookie；公共登录路径不代注旧 Bearer。
2. 当前后端专用 namespace，目标严格校验；query/Referer/同后端资源重定向保持语义。
3. 文档保持 pathname；绝对业务域资源与已登记微应用 frame 的相对资源归上游；主 SPA 静态保留本地。
4. 保留微应用前缀，新文档根显式登记。

## WS2：会话鉴权与注册

落点 overlay sessionAuthInjection、共享规则、nuwaxBridgeHandlers/commercialAuth、preload 与测试。

1. 单 listener，保留 x-client-type，显式 HTTP(S)/WS(S)，按 origin 与可信 frame 注入。
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
