<!--
用法：intent 接受后经 grill-with-docs 收敛为本规格；存 specs/<feature-slug>.md。
闸门：技术评审通过后才进 Build（plan mode → plans/*-plan.md）。
-->

# 规格：loopback 网关形态登录态 header 单通道收编

- 对应 intent：`plans/20260921-loopback-login-sync-intent.md`（设计论证与引文详见 `docs/20260921-loopback-login-sync-research.md`）
- 对应计划：`plans/20260921-loopback-login-sync-plan.md`
- 状态：技术评审通过（2026-09-22 对现状复核后修订，修订点见第 6 节）

## 1. 需求基线

### 背景

Nuwax 客户端（商业版）本地化加速（loopback gateway）形态下，webview 从 `http://127.0.0.1:<port>` 加载前端产物，网关反代业务域。登录态当前有两条通道同时抵后端：页面自带的 `Authorization: Bearer` 与浏览器自动附带的 `Cookie: ticket`。后端既定行为是「有 cookie 只认 cookie」，因此「新 Bearer + 旧 ticket」组合一旦出现即 401。

今日未爆的唯一原因是 `ticket ≡ token` 同值同刻写入（登录响应同时产生两者）。任一 token 变更路径（跨 origin 迁移、重登后异 origin jar 残留、后端中途重发 Set-Cookie）都会打破该巧合。

### 本期做

1. 让 gateway 路径的鉴权**结构性只剩 header**：网关出口剥 `ticket` cookie，其余 cookie 原样转发。
2. 收编/兜底六类逃逸面，使页面请求不再以「业务域直连 + 无 Bearer」形态抵达后端：
   - ⑤ 微应用页内绝对 URL、⑥b 业务域非 `/api` 前缀的图片/文件资产 → 网关命名空间收编
   - ① 外链菜单/微应用独立窗 → `native:openWindow` 重写
   - ③ 结算回跳页轮询 → 前端改相对路径
   - ④ 4011 跳转 → 前端同源映射
   - ② 收银台 → 保持外部域现状（orderId 会话自理）
   - ⑥a 受保护 `/api/f/`、⑥c 公开 OSS 域 → 现机制已通，列回归
3. 未知逃逸兜底：壳 session 层 `onBeforeSendHeaders` 对「目标=业务域且缺 Authorization」的请求补 Bearer（含导航/子资源/WS upgrade）。
4. cookie 降级为**受控镜像**：只存 settings 键（reg feedstock）与 127.0.0.1 jar（登录自然落值，出口剥离后永不抵后端）。不向任何页面可见 jar 主动种 ticket。

### 本期不做

- 后端改动（仅输出协调清单，见 `docs/20260921-loopback-login-sync-research.md` 第 7 节）。
- qiankun 微前端化。
- token 续期机制落地（依赖协调清单 #1 答复，仅预留挂点）。
- 基座仓结构性改动（WS2 的 listener 接管在 overlay 内完成，基座仅一次注释级指向，见第 4 节）。
- 回收 `MICROAPP_BACKEND_PREFIXES`——复核后确认其为**结构性必需**而非过渡垫片，见第 6.1 节。

## 2. 方案设计

### 2.1 架构落点

改动全部落在 **overlay**（`overlay/crates/agent-electron-client/`，经 `scripts/sync-overlay.js` 同步进基座工作树）与 **nuwax 前端 submodule**。基座零功能改动。

| 层 | 落点 | 职责 |
|---|---|---|
| 网关 HTTP 层 | `services/loopbackGateway/gateway.ts` | 命名空间路由（dist 模式判别分流）、出口剥 ticket |
| 网关编排层 | `services/loopbackGateway/index.ts` | 绝对 URL 归一钩子按资源类型分流 |
| 桥 IPC 层 | `ipc/nuwaxBridgeHandlers.ts` | `native:openWindow` 路径保持式重写 |
| 壳 session 层 | `services/sessionAuthInjection.ts`（新增） | 未知逃逸的 Bearer 兜底注入，接管 `onBeforeSendHeaders` |
| 前端 | `nuwax/` submodule | 结算轮询相对路径、4011 同源映射 |

单向依赖保持不变：`index.ts → gateway.ts`、`ipc/nuwaxBridgeHandlers.ts → ipc/commercialAuth.ts`。新模块 `sessionAuthInjection.ts` 只读 `commercialAuth` 的取域/取 token 助手，不回写、不持状态。

### 2.2 数据与契约

**新增 URL 契约：`/__backend/<host>/<path>`**

- `<host>` 必须命中白名单，否则 403。白名单 = 当前业务域 host（`currentBusinessOrigin()`）+ env 别名旋钮（`NUWAX_GATEWAY_BACKEND_HOSTS`，逗号分隔）。
- **仅用于非文档子资源请求**（`resourceType` 非 `mainFrame`/`subFrame`）。理由见第 6.2 节。
- 文档导航（`mainFrame`/`subFrame`）继续走**路径保持式**改写（`gatewayOrigin + path`），复用现有 SPA 回退语义。

**`<host>` 校验（安全契约，不可简化）**

必须先在**原始未 decode** 的路径段上取 host，用严格正则校验，再构造 URL 并对解析结果的 `hostname` 复核：

```
^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$   // i
```

直接写 `new URL('https://' + segment + rest)` 会被 `/__backend/agent.nuwax.com@evil.com/`（userinfo 分隔）与反斜杠（WHATWG URL 在 special scheme 下把 `\` 当 `/`）绕过白名单。转发路径须经 `new URL()` 规范化以消解 `..`。

**出口剥 ticket（`buildProxyHeaders`）**

从 `cookie` 头仅剥 `ticket` 名条目，其余 cookie 原样保留（后端可能另有非鉴权 cookie）。WS upgrade 路径同走 `buildProxyHeaders`，自动同规。

**反代响应 `set-cookie` 预留挂点**：命中 `ticket` 且值 ≠ settings 当前镜像时记日志，协调清单 #1 答复前不动作。

**settings 键空间不变**：`nuwax.accessToken.<origin>`、`nuwax.ticket.<origin>`、`step1_config`、`nuwax.loopback`。WS2 取 token 必须复用 `nuwaxTokenScopes()`（`ipc/nuwaxBridgeHandlers.ts:113-131`，已导出）而非新造候选集合，否则重现「写 A 读 B」键空间分裂。

### 2.3 平台/引擎矩阵

| 行为点 | gateway 形态 | direct 形态 |
|---|---|---|
| 页面 `/api/..` 请求 | 网关前缀反代，缺 Auth 代注，出口无 ticket → 纯 header | 同源直连，页面带 Bearer |
| 业务域非前缀绝对 URL（子资源） | 归一钩子改写到 `/__backend/<host>/<path>` → 反代 | 同源直连，无需归一 |
| 业务域绝对 URL（文档导航） | 归一钩子路径保持式改写 → 前缀命中反代 / SPA 回退 | 同源直连 |
| `native:openWindow` 绝对 URL | host=业务域 → 路径保持式改写进网关 | 不重写，直开 |
| 结算轮询 | 相对路径 → 网关反代（代注或页面自带 Bearer） | 相对路径 → 同源 cookie |
| 4011 跳转 | 同 host → 映射到当前 origin 同路径 | 原行为 |
| 终端 ttyd WS | 网关代注 Bearer（`/computer` 前缀内） | **session 层兜底注入**（修存量缺口） |
| `x-client-type` | 网关 `buildProxyHeaders` 注入（目标回环跳过） | session listener 注入（目标回环跳过） |

## 3. 异常与失败场景

| 场景 | 期望行为 |
|---|---|
| `/__backend/` 的 host 不在白名单 | 403，不反代；记日志（防本机网关沦为开放代理） |
| `/__backend/<host>/` 的 host 段含 `@`、`\`、`/`、异常端口 | 403（严格正则拒绝） |
| 命名空间目标不可达 | 复用 `proxyRequest` 现有 502 引导页（HTML 请求）/ JSON（API 请求） |
| 上游不可达 + 命名空间路径 | 同上；不得泄漏 `/__backend/` 前缀进用户可见文案 |
| 剥 ticket 后 jar 仍持续收到 `Set-Cookie: ticket=` | 正常（jar 只作 reg feedstock 与续期观测点），出口永不转发 |
| 登录/验证码接口 | session 层注入豁免（`/api/user/passwordLogin`、验证码登录路径），避免旧 token 干扰后端凭据判定 |
| session listener 接管失败/未挂载 | 启动日志必须显式报「已接管 onBeforeSendHeaders」；缺失即 `x-client-type` 与 Bearer 双失效，属 P0 |
| 网关停止（`stopAbsoluteUrlNormalization`） | 只摘 `onBeforeRequest`（传 null 会摘掉该事件**全部** listener），不得影响 `onBeforeSendHeaders` |
| `localStorage.ACCESS_TOKEN` 缺失（结算页） | 轮询 401 → 走现有错误 UI；不得静默死循环轮询 |
| 4011 下发 URL 与配置域不同 host | 保持原跳转（外站/IdP 场景） |
| 4011 下发 URL 为相对路径或含 `://` 的登录 redirect | 同源映射只处理「绝对 URL 且 host 与配置域相同」；其余原样 |

## 4. WS2 listener 接管（Electron 单 listener 约束）

Electron 官方文档明确：`webRequest` 事件「**Only the last attached listener will be used.** Passing `null` as `listener` will unsubscribe from the event.」

因此 `session.defaultSession.webRequest.onBeforeSendHeaders` 全局只有一个生效 listener。现状基座 `src/main/main.ts:773-796` 已注册 x-client-type 注入；overlay 若要加 Bearer 注入，**只能整体接管该事件**。

- 接管点：`registerAllHandlers`（`main.ts:860`）尾部，与 `powerPolicy.initPowerPolicy()` / `fullDiskAccess.initFullDiskAccessGuard()` 同款 boot 钩子。
- 时序是承重墙：`main.ts:773`（基座注册）< `main.ts:860`（`registerAllHandlers`），后注册者胜，故 overlay listener 确实覆盖基座 listener。**该顺序无任何断言保护**，基座若在 860 之后新增 `onBeforeSendHeaders` 注册，Bearer 注入会被静默顶掉。
- 新模块必须**逐字复制**基座的 x-client-type 语义（目标 host ∈ {localhost, 127.0.0.1, ::1} → 两个头都不加；否则 `x-client-type = APP_NAME_IDENTIFIER`），并在模块头注释标注镜像来源 `main.ts:764-799`。
- Bearer 注入判定在 x-client-type 逻辑之后执行：目标 host = 业务域 host 且 `authorization` 缺失且路径不在豁免清单 → 从 `nuwaxTokenScopes()` 候选键取首个非空 token 注入。
- 启动日志显式声明接管成功。

## 5. 测试计划

### 单测（overlay，`vitest`，落点与现有测试同目录）

`services/loopbackGateway/gateway.test.ts`（现有 443 行，真 http 上游 + electron-log mock）：
- 命名空间路由：白名单 host 正常反代（含路径与 query 保真）；非白名单 403；host 段含 `@`/`\` 403；带扩展名静态资产不落 dist 404
- 出口剥 ticket：`cookie: a=1; ticket=T; b=2` → 上游收到 `a=1; b=2`；无 ticket 时 cookie 原样；WS upgrade 同断言
- referer 改写：命名空间 URL 的 referer 不得泄漏 `/__backend/<host>` 前缀
- 上游路径不得含 `/__backend/<host>` 前缀

`services/loopbackGateway/index.test.ts`（现有 311 行，全 mock electron + db + gateway）：
- 归一钩子：业务域绝对 URL 且 `resourceType=xhr/image/media` → 命名空间；`resourceType=mainFrame/subFrame` → 路径保持式；非业务域不动；壳 renderer 发起不动（guest 判定）

`services/sessionAuthInjection.test.ts`（新增）：
- 判定表：host 匹配/不匹配、有/无 authorization、豁免路径命中/未命中、回环目标跳过
- x-client-type 镜像行为与基座逐字一致（回环跳过 + 非回环注入）
- token 取键与 `nuwaxTokenScopes()` 同源

`ipc/nuwaxBridgeHandlers` 侧：
- `native:openWindow`：业务域绝对 URL 路径保持式改写；外站直开；gateway 关闭不重写

### 前端单测（nuwax，`vitest`，130 个现有测试文件）

- 4011 同源映射助手：同 host 映射 / 不同 host 原样 / 相对路径原样 / 坏 URL 原样
- `fetchStatus` 基址与 Bearer 附带条件（如可测）

### 手动/真环境（见计划 WS4 验收矩阵）

dev（mac `npm run base:dev`）过 V1-V6；打包版（prerelease tag）过 V1-V9 全量。

### 回归基线

`npm run test:commercial` 当前基线：**124 test files passed / 1 skipped，1513 tests passed / 18 skipped**（2026-09-22 实测，exit 0）。合并主干前另跑 `npm run base:test`（隔离副本）+ `npm run check:pin`。

## 6. 已否决的备选方案

### 6.1 回收 `MICROAPP_BACKEND_PREFIXES`（过渡垫片）——**否决，改为永久保留并重新定性**

原计划把它当过渡垫片，「验收后回收」。复核发现前端**自身就用 `window.location.origin` 拼后端路径**，产出同源网关 URL，根本不经过绝对 URL 归一钩子：

- `nuwax/src/pages/SpaceProjectManage/AppProjectDetail/index.tsx:974-982`：`const domain = window.location.origin; return \`${domain}/repo/doc/...\``
- `nuwax/src/layouts/DynamicMenusLayout/utils.ts:19-27`：`%siteUrl%` → `window.location.origin`

这些 URL 抵达网关后仍靠 `backendPrefixes` 命中才能反代。命名空间收编的只是「后端下发的绝对 URL」这一类。

**重新定性**：`MICROAPP_BACKEND_PREFIXES` = **后端微应用文档根白名单**，与命名空间路由（子资源逃逸兜底）分工，两者都常驻。要真正回收它，必须同步改前端让这些路径也走命名空间（= 前端新增一个 `toBackendUrl()` 助手并要求业务域 host 可知），属另一批工作。

### 6.2 命名空间路由用于文档导航——**否决，收窄到非文档子资源**

原计划让归一钩子把业务域绝对 URL 一律改写成 `/__backend/<host>/<path>`。复核发现两类硬伤：

1. **`native:openWindow` 加载的是 nuwax 自家 SPA 路由**（处理器文档注释：「智能体详情/工作流/网页应用开发/我的电脑等全屏页」）。SPA 路由读 `location.pathname`，改写后多出 `/__backend/<host>` 两段 → **每个 NewTab 二级页全挂**。
2. **iframe 文档导航同理**：`/instant-message`、`/repo` 进前缀清单正是为了 subFrame 文档导航。微应用 router 对 pathname 敏感，改写有回归风险。

**改为**：命名空间只用于 `resourceType` 非 `mainFrame`/`subFrame` 的子资源。这恰好覆盖用户实际上报的「消息/资料库菜单页面下的**内部请求**」（多为 xhr/fetch/img），且零 pathname 风险。文档导航继续走路径保持式改写 + 现有 SPA 回退语义（对 SPA 路由是正确的）。

**残留缺口（明示）**：文档导航到「清单外的后端微应用新根路径」仍会被 SPA 兜底吃掉，需加前缀或用 env 旋钮。此为已知边界，非本期目标。

### 6.3 命名空间的实际价值（为什么仍然需要）

dist 模式的 HTTP 层（`http.createServer` 回调）**看不到 Electron 的 `resourceType`**，只能靠 `Accept`/`sec-fetch-dest` 猜。归一钩子在 Electron 层有权威的 `resourceType`，需要一个**信道**把「这是子资源、请反代」的决策传给 HTTP 层。`/__backend/<host>/<path>` 就是这个信道。这也解释了为什么不能只用「dist 文件不存在就反代」的默认放行——那会让文档导航的 SPA 深Link 也被反代掉。

### 6.4 业务域种 cookie 地板（B 方案）——维持撤销

靠枚举同步点维持种子新鲜：重登、后端滑动续期、跨形态切换任一遗漏即复现「新 Bearer + 旧 ticket」必炸场景。且 WS2 兜底已覆盖其全部收益面。

### 6.5 基座加中立 seam（header contributor 注册表）——维持不选

需基座一次 PR，且 attach 时序要与注册时序对齐；在单消费者（WS2）场景下收益不抵成本。

## 7. 待确认（后端协调清单）

随 `docs/20260921-loopback-login-sync-research.md` 第 7 节沟通。阻塞项：#2（ACAO 放行回环 origin，影响 WS2 兜底路径的 preflight）、#6（资产 URL 契约，决定 ⑥b 是理论风险还是现网缺陷）。#1 答复前续期挂点只记日志不动作。
