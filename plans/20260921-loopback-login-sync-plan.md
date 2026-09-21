# 实施计划：loopback 登录态同步 header 单通道收编

- 日期：2026-09-21
- 调研依据：`docs/20260921-loopback-login-sync-research.md`（图 1-5、方案对比、协调清单）
- 目标：gateway 形态下「新 Bearer + 旧 ticket」结构性不可达后端；六类逃逸面（含⑥图片/文件资源 URL）全部收编或兜底；cookie 降级为受控镜像
- 非目标：后端改动（仅输出协调清单）；qiankun 微前端化；token 续期机制落地（依赖协调清单 #1 答复，仅预留挂点）

## 改动总览

| WS | 内容 | 仓/落点 | 依赖 |
|---|---|---|---|
| WS1 | 网关收编：命名空间路由 + host 归一 + 出口剥 ticket + openWindow 重写 | 外层 overlay（loopbackGateway/gateway.ts、index.ts、ipc/nuwaxBridgeHandlers.ts）+ gateway.test.ts | 无 |
| WS2 | 会话级 Bearer 注入（未知逃逸兜底） | overlay 新模块 + boot 钩子挂载（registerAllHandlers 尾部，powerPolicy/fullDiskAccess 同款先例） | WS1 可并行 |
| WS3 | 前端修正：结算轮询改相对路径 + 4011 同源映射 +（可选）authChanged 刷新监听 | nuwax 仓（feat-dong.0930）+ dist 重建 + 外层 pin bump | 可与 WS1/2 并行 |
| WS4 | 验收矩阵执行 | dev + 打包版（prerelease） | WS1-3 齐后 |

## WS1 · 网关收编（overlay）

### 1a 命名空间路由 `/__backend/<host>/<path>`

`gateway.ts` dist 模式路由层（现 `gateway.ts:400-441` 前缀匹配处）新增：

- 命中 `/__backend/<host>/<path>` 的请求：`<host>` 必须在**host 白名单**内（= targetOrigin 的 host；别名扩展走 env 旋钮，同 `NUWAX_GATEWAY_EXTRA_BACKEND_PREFIXES` 风格），否则 403——防本地网关变开放代理
- 命中后按 `https://<host>/<path>` 反代（沿用 `proxyRequest`/`proxyUpgrade`，scheme 取 targetOrigin 的 scheme）
- `/__backend` 前缀**先于**静态托管与 SPA 回退判定（否则又会被 index.html 兜底吃掉，重蹈⑤）；也不进 `backendPrefixes` 集合语义
- 归一化辅助导出：`toBackendNamespaceUrl(absUrl) -> string | null`（host 不在白名单返回 null）供 1c/1d 与归一钩子共用

### 1b 绝对 URL 归一钩子改按 host 改写

`index.ts:335-385` `startAbsoluteUrlNormalization`：

- 现行为：业务域绝对 URL → `gatewayOrigin + 原路径`（依赖前缀清单承接）
- 改为：业务域绝对 URL → `gatewayOrigin + /__backend/<host>/<path>`（不依赖前缀清单，清单制天然滞后是⑤⑥b 根因）
- 覆盖面含⑥b：业务域非 /api 前缀的图片/文件资产 URL（img src / window.open / FilePreview 裸 src，见调研文档⑥命运矩阵）经 host 改写进命名空间后统一反代，不再被 dist 静态/SPA 兜底吃掉；⑥a（/api/f/ 受保护）不走命名空间（路径已在 /api 前缀内，hook Bearer fetch 与网关代注双通道维持现状），列入 V9 回归
- guest 判定（发起页 origin=网关 origin）保留不动——壳 renderer 直连不归一的 CORS 理由（`index.ts:353-374` 注释）仍然成立
- `MICROAPP_BACKEND_PREFIXES` 与 env 旋钮保留一个过渡期（已发布的旧 dist 里页面仍可能发起前缀式路径），验收后回收；`DEFAULT_BACKEND_PREFIXES`（/api 等）语义不变

### 1c 网关出口剥 ticket

`gateway.ts` `buildProxyHeaders`（:103-133）：

- 转发前从 `cookie` 头剥掉**仅 `ticket` 名**的条目（其余 cookie 原样保留——后端可能另有非鉴权 cookie）
- WS upgrade 路径同走 `buildProxyHeaders`（:219），自动同规
- 效果：gateway 路径纯 header；127.0.0.1 jar 里的 ticket 永不抵后端（`captureTicketCookie` 读 jar 不受影响，续期观测点保留）
- 同点预留：反代响应 `set-cookie` 命中 `ticket` 且值 ≠ settings 当前镜像时，回调通知 index.ts 更新 `nuwax.ticket.*` 并广播（续期挂点，协调清单 #1 答复前只记日志不动作）

### 1d native:openWindow 重写

`nuwaxBridgeHandlers.ts:742-761`：

- `loadURL` 前：gateway 启用 且 URL host=业务域 host → `toBackendNamespaceUrl` 改写（`_shell=1` 参数在改写后的 URL 上追加）
- 真外站（squareBannerLinkUrl、IdP 等 host 不匹配）保持直开
- 独立窗与 webview 共用桥 preload（:749-757），改写后整窗在网关 origin 上，页面 `auth.getToken` 回退链自举照常可用

### 1e 测试（gateway.test.ts / index.test.ts）

- 命名空间路由：白名单 host 正常反代；非白名单 403；`/__backend` 不被 SPA 回退吃掉；带扩展名静态资产（如 `/__backend/<host>/files/x.png`）正常反代不落 dist 404
- 归一钩子：业务域绝对 URL 改写到命名空间；非业务域不动；壳 renderer 发起不动（沿用现有 guest 判定用例）
- 出口剥 ticket：`cookie: a=1; ticket=T; b=2` → 上游收到 `a=1; b=2`；无 ticket 时 cookie 原样；WS upgrade 同断言
- openWindow 重写：业务域 URL 进命名空间；外站直开；gateway 关闭时不重写

## WS2 · 会话级 Bearer 注入（overlay 新模块）

新模块 `overlay/.../main/services/sessionAuthInjection.ts`，boot 钩子从 `registerAllHandlers` 尾部挂载（`powerPolicy.initPowerPolicy()` 同款位置）。

**单 listener 约束（关键设计点）**：defaultSession 的 `webRequest.onBeforeSendHeaders` 后挂覆盖先挂（main.ts:762 的 x-client-type 注入会被顶掉）。两个选项：

- **首选：overlay 整体替换**——模块内 listener 自含复制 x-client-type 注入逻辑（原判定原样：目标回环跳过、值=APP_NAME_IDENTIFIER）+ 新增 Bearer 注入。商业构建必然加载 overlay，替换确定性生效；基座零改动，符合「商业专属逻辑归 overlay」定案。代价：x-client-type 逻辑两处存在，基座改动时需同步（在模块头注释标注镜像来源 main.ts 行号）
- 备选：基座加中立 seam（header contributor 注册表）——基座需一次 PR，且 attach 时序要与注册时序对齐；除非后续还有第二消费者，否则不引入

注入判定（在替换后的 listener 内，先于 x-client-type 逻辑执行）：

1. 请求目标 host = 业务域 host（serverHost 解析）
2. `authorization` 头缺失
3. 路径**不在豁免清单**：`/api/user/passwordLogin`、验证码登录路径（防旧 token 附在重登请求上干扰后端凭据判定）
4. 发起方为本应用页面（defaultSession 内一切 webContents 天然满足，无需额外判定）

命中则从 token 候选键（`serverHostTokenProvider` 同源取键）注入 `Authorization: Bearer <token>`。导航/子资源/WS upgrade 均经此 listener，天然全覆盖——兼修「gateway 登录→关加速→直连形态 WS 无 cookie」存量缺口（terminalWsUrl 按当前 origin 拼装、无 token 通道）。

CORS 注意：gateway origin 页面对业务域的跨域请求被注入 Authorization 后触发 preflight，需后端 ACAO 放行回环 origin（协调清单 #2）；命名空间收编（WS1）后绝大多数请求回同源，仅兜底路径受影响，不阻塞本 WS。

测试：单测覆盖判定表（host 匹配/不匹配、有/无 authorization、豁免路径）；注入源与网关代注同键空间的断言。

## WS3 · 前端修正（nuwax 仓 feat-dong.0930）

1. **结算回跳页轮询**（`public/static/payment-settlement.html:217-244`）：轮询基址从硬编码 `https://testagent.xspaceagi.com` 改为当前 origin 相对路径——gateway 形态走网关反代（网关代注/出口剥离均适用），direct 形态同源直连，两形态统一
2. **4011 同源映射**（`common.ts:175-181`、`userService.ts:100-103`）：后端下发 URL 与配置域同 host 时改跳当前 origin 同路径（经网关反代），非同 host 保持原跳；实现放 `utils/router.ts` 旁，判定用运行时配置域（与壳 serverHost 同源的现有前端常量）
3. **（可选，协调清单 #1 答复后再做）authChanged 刷新监听**：`hostBridge` 增加 auth 变更事件订阅，收到新 token 时刷 `localStorage.ACCESS_TOKEN`——为续期推送预留，未答复前不做
4. **dist 重建 + 提交流程**：`git add -f dist --no-verify`（/dist 在 gitignore、lint-staged 挂 dist）→ 提交前端仓 feat-dong.0930 → 外层 bump nuwax 子模块 pin（release/v1.0.x）。注意勿动 `~/workspace/nuwax` 主检出上的用户并行 WIP——用 fetch+worktree 方式提交

## WS4 · 验收矩阵

| # | 场景 | gateway 形态 | direct 形态 |
|---|---|---|---|
| V1 | 消息/资料库菜单 NewTab 独立窗 | 打开即登录态可用（命名空间收编，页面请求经网关） | 天然同源（回归不破坏） |
| V2 | 微应用页内新路径（清单外） | 不再 404/回首页（host 归一进命名空间） | 同左 |
| V3 | 购买→收银台→回跳→结算轮询 | 轮询走当前 origin，登录态可用；收银台内外域导航/后退正常（bug2432 回归） | 同左 |
| V4 | 4011 触发 | 同 host URL 留在网关 origin 内跳转；异 host 原行为 | 原行为 |
| V5 | 加速开关切换（gateway↔direct）后开终端 WS | 不适用（仍 gateway） | **WS 连通**（会话级注入兜住，修存量缺口） |
| V6 | 双通道断言 | 网关出口日志/单测：页面带 Bearer+cookie 时上游只收到 Bearer 与非 ticket cookie | 不适用 |
| V7 | 重登（旧 jar 残留模拟） | 重登后全链路请求 200，无「旧 ticket 压新 Bearer」401 | 同左 |
| V8 | 登出/过期/换域 | 三档清理语义回归（token/ticket 键、clearSiteStorage、回登录页） | 同左 |
| V9 | 图片/文件资源显示（⑥） | 受保护图标 blob 显示（技能/连接器/专家/项目图标）、FilePreview 裸 src 打开 `/api/f/` 预览、公开 OSS 图标直显；若有⑥b 现实样本（业务域非 /api 资产路径）验证命名空间收编后可显示 | 同左（回归不破坏） |

执行通道：dev（mac `npm run base:dev` + win-pc 配方）过 V1-V6；打包版（prerelease tag）过 V1-V8 全量；V6 另有 gateway.test.ts 单测常驻。

## 门禁与提交

- 每次源码改动后：`node scripts/sync-overlay.js && npx vitest run`（test:commercial 轨）；合并主干前 `npm run base:test`（隔离副本）+ `npm run check:pin`
- 提交三仓：壳基座（本计划基座零改动，预计无基座提交；若 WS2 取备选 seam 则基座一次 PR）；外层仓 overlay 改动提交 release/v1.0.x（须先 `npm run check:pin`）；前端仓 feat-dong.0930（worktree 方式）
- 发版提醒：外层 `nuwax-default-server-host-overlay-seed` 待办（stable 前 TEST_SERVER_HOST→DEFAULT_SERVER_HOST）与本批无耦合，勿混提

## 实施顺序

1. WS1a/1c（命名空间路由 + 出口剥 ticket）——1c 是双通道隐患的直接修复，最小可独立交付
2. WS1b/1d（归一钩子改写 + openWindow 重写）——依赖 1a
3. WS2（会话级注入，替换 listener）——独立可并行；上线前必须与 WS1c 同批（否则注入把 Bearer 带到业务域直连请求上，与残留 cookie 形成 WS2 自己造的双通道）
4. WS3 前端修正 + dist + pin bump
5. WS4 验收矩阵 → prerelease 打包版抽查

## 开放决策点

- WS2 首选方案（overlay 整体替换 listener）是否接受 x-client-type 逻辑镜像的维护代价——默认按首选执行
- 微应用前缀垫片回收时机（qiankun 化排期 vs 验收后即收）
- 续期挂点（1c 预留）是否升级为动作：等协调清单 #1 答复
