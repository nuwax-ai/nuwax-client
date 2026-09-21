# loopback 网关形态登录态同步调研：header vs cookie（含续期）

- 日期：2026-09-21
- 范围：Nuwax 客户端（商业版）本地化加速（loopback gateway）形态下，登录态在「网关 origin ↔ 配置业务域」之间的同步方案
- 边界：壳侧（overlay+基座）与 nuwax 前端可改；后端只输出协调清单，不在本批实施范围
- 结论实施计划见 `plans/20260921-loopback-login-sync-plan.md`

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| 主鉴权通道 | **header（Bearer）单通道**。生产直连 web 全量 Bearer 已实证可行；网关形态代注机制已存在 |
| cookie 的角色 | **降级为受控镜像**：只存 settings 键（reg feedstock）与 127.0.0.1 jar（登录自然落值，出口剥离后永不抵后端）。**不向任何页面可见 jar 主动种 ticket** |
| 双通道隐患 | 后端「有 cookie 只认 cookie」（后端给定事实）⇒ 「新 Bearer + 旧 ticket」组合必须**结构性不可达**：网关出口剥 ticket cookie，而非靠同步时序保证两 jar 同值 |
| 逃逸页面（仍走配置域名） | 六类，全部收编或兜底：①外链/微应用独立窗、⑤微应用内部绝对 URL、⑥b 业务域非 /api 前缀的图片/文件 URL → 网关命名空间收编；③结算轮询、④4011 跳转 → 前端修正；②收银台 → 保持外部域现状（orderId 会话自理）；⑥a 受保护 `/api/f/` 与 ⑥c 公开 OSS 域 → 现机制已通，列入回归 |
| 续期 | 现状=无续期（token 登录产生、4010 失效、重登恢复）。后端若引入续期，方案=网关拦截 Set-Cookie → settings 镜像 → `nuwax:authChanged` 推送 → 前端刷 localStorage（列可选项） |

## 1. 形态与术语

- **gateway 形态（本地化加速）**：webview 加载 `http://127.0.0.1:46800`（`gateway.ts:447` 固定端口，被占回退随机），网关 dist 模式本地托管前端产物 + 反代业务域。启用键 `step1_config.nuwaxLoadMode="gateway"`（`index.ts:101-106`）
- **direct 形态**：webview 直接加载配置业务域（`step1_config.serverHost`，缺省 `agent.nuwax.com`）
- webview origin 决策优先级（`NuwaxHostWebview.tsx:131-185`）：`nuwax.webviewOverride`（env 权威源）> `nuwax.loopback`（gateway 形态）> `serverHost`
- **ticket**：后端登录响应 `Set-Cookie ticket=<JWT>`，值与 `data.token` 是同一 JWT；reg 请求以 `Cookie: ticket=` 附带可放行无 savedKey 的首登注册（`commercialAuth.ts:197-204`）
- 后端鉴权优先级（**本调研的设计约束，后端给定**）：请求携带 cookie ticket 时只认 cookie——过期 ticket 会压过更新的 Bearer 头

## 2. 图 1 · 现状：gateway 形态登录链路

```
webview 127.0.0.1:46800          网关(主进程)                后端 serverHost
────────────────────         ─────────────────────      ─────────────────
① POST /api/user/passwordLogin
   (经网关, 注入 x-client-type) ──── 反代 ──────────────> 密码校验
                               <── {data.token=T} ＋ Set-Cookie ticket=T
                                        │
                        ② normalizeSetCookie:
                           剥Domain/Secure, SameSite→Lax
                           (ticket 从此只落在 127.0.0.1)
                    ┌─────────┴──────────┐
                    ▼                    ▼
        ③a ticket 进 127.0.0.1     ③b 前端写 localStorage
            cookie jar(内存态)          .ACCESS_TOKEN=T
                                        │
                              ④ 桥 auth:persistToken(T)
                                        ▼
                    壳 settings 表【三候选键双写】
                    nuwax.accessToken.<127.0.0.1:46800>
                    nuwax.accessToken.<serverHost>
                    nuwax.ticket.<origin> ← captureTicketCookie
                                        │
                              ⑤ AuthLifecycle.start()
                              reg: Bearer T + Cookie ticket=T
                              → configKey/savedKey → 拉起本地服务
```

引文对照：

- ① 网关对云端方向注入 `x-client-type`（`gateway.ts:126`）；壳 session 层对目标为回环的请求跳过注入避免重复（`nuwa-electron-shell/crates/agent-electron-client/src/main/main.ts:765-779`）
- ② `normalizeSetCookie`（`overlay/.../loopbackGateway/gateway.ts:74-100`）：剥 `Domain`/`Secure`、`SameSite=None→Lax`——注释原文「origin 已是 http://127.0.0.1，这些属性反而会导致 Cookie 被浏览器丢弃」。应用于反代响应（:160-164）
- ③a+④ `persistToken` 三候选键双写（`overlay/.../ipc/nuwaxBridgeHandlers.ts:527-537`）；候选集合=sender origin、业务域 origin、网关 origin（`nuwaxTokenScopes`，:105-130，注释「direct↔gateway 共存期防写 A 读 B 键空间分裂」）；`captureTicketCookie` 从 Electron session 读 ticket 双写 `nuwax.ticket.<origin>`（:405-437）
- ⑤ reg 双凭据（`overlay/.../ipc/commercialAuth.ts:206-214`）：`Authorization: Bearer` + `Cookie: ticket=` 同时发，两值均在调用时从 settings 键现读（:186、:202-204），属**壳侧受控双通道**——与页面级双通道不同，值必然同批新鲜
- token 迁移免重登：`auth:getToken` 回退链命中候选键即回写 sender 键（`nuwaxBridgeHandlers.ts:483-503`，日志「origin 迁移回退命中」）——**只迁 token 键，不迁 cookie jar**

## 3. 图 2 · 现状：日常请求鉴权三泳道（A 今天就是双通道）

```
页面 JS                        网关 46800                   后端 serverHost
────────────                 ─────────────               ─────────────
A. umi request(带Bearer)
   Authorization: Bearer T ──> host/origin/referer改写 ──> 只认 Bearer ✅
   (相对路径 /api/..)           x-client-type=nuwax
                               缺Auth才代注(带了就不动)
                               cookie 原样转发 ⚠️ ◄── A 也带上了
                                 127.0.0.1 jar 里的 ticket
                                 → A 实际= Bearer+cookie 双通道

B. iframe导航/WS/raw fetch
   (带不了 Authorization)  ───> 网关代注 Bearer ✅ ──────> 认 Bearer ✅

C. 逃逸到业务域直连的请求 ────── 不经网关 ──────────────> 业务域 jar 无
(openWindow/硬编码/4011跳转)                           ticket 无 Bearer
                                                       → 失登 ❌
```

引文对照：

- A：前端拦截器从 localStorage 取 token 注入 Bearer，无域名白名单、不看 URL（`nuwax/src/services/common.ts:257-263`）；网关 `buildProxyHeaders` **全量复制非逐跳头**——包括浏览器自动附上的 `cookie`（`gateway.ts:109-112`），仅当 `authorization` 缺失才代注（:128-131）
- B：iframe 导航 / raw fetch / **WS upgrade** 同走 `buildProxyHeaders`（`proxyUpgrade`，`gateway.ts:211-232`）——代注对 WS 握手同样生效（终端 ttyd WS 无 token 通道，`nuwax/src/utils/terminalWsUrl.ts:34-52` 按当前 origin 拼 URL）
- C：见第 5 节五逃逸面
- 网关路径**今天就双通道**：图 2 泳道 A 里页面 Bearer 与 127.0.0.1 jar 的 ticket 同时抵后端。当前未爆的唯一原因是 ticket≡token 同值同刻写入（登录响应同时产生两者）。这正是第 4 节隐患的现网形态

## 4. 图 3 · 隐患：后端「有 cookie 只认 cookie」＋ 旧 ticket 残留 = 必炸

```
t0  登录成功: token=T0, ticket=T0 (同值同刻写入, 所以今天没炸)
t1  某次 token 变更/迁移/后端只续 cookie 不续 token:
       页面 Bearer=T1(新)   jar ticket=T0(旧, 浏览器自动带)
t2  请求抵后端:
       Authorization: Bearer T1   ┐
       Cookie: ticket=T0          ├─> 后端只认 cookie → T0 过期 → 401 ❌
                                  ┘    (T1 再新也没用)

结构性结论:
  · 不能靠「同步时序」保证两个 jar 永远同值 → 必须让组合不可达
  · 手段1: 网关出口剥 ticket (gateway 路径纯 header)
  · 手段2: 不向任何页面可见 jar 种 ticket (「cookie 地板」方案撤销)
```

t1 的现实触发面（枚举）：

1. **后端会话中途重发 Set-Cookie（滑动续期）**：jar 里 ticket 更新为 T1，页面 localStorage token 仍是 T0（前端只在登录时写 token，`Login/index.tsx:192-197`；全仓无 refresh/renew 接口，`EXPIRE_DATE` 只写不读）——此方向下 cookie 是新值，若后端 cookie 优先反而「救」了请求，但 gateway 关闭切换到 direct 形态后业务域 jar 无 cookie，行为分叉
2. **token 跨 origin 迁移**：`getToken` 回退链只回写 token 键不碰 cookie jar（`nuwaxBridgeHandlers.ts:483-503`）——切形态后新 origin 的 jar 可能空 cookie（无隐患）或残留下次登录前的旧 cookie（隐患）
3. **重登后异 origin jar 残留**：在网关 origin 重登，127.0.0.1 jar 的 ticket 被 Set-Cookie 覆盖；但若曾在业务域 jar 种过值（原 B 方案设想），旧种子残留 → 业务域直连页面带着新 Bearer + 旧 ticket 抵后端 → **正是用户指出的必炸场景，B 方案因此撤销**
4. **reg 双发**（`commercialAuth.ts:206-214`）：壳侧 net.fetch，两值同批现读，调用前刚经 `getToken`/`captureTicketCookie` 刷新，风险低；但若后端重发过 ticket 而 settings 镜像未跟上（观测点缺失），reg 也会带着旧 ticket + 新 Bearer 触发 401→`expired`→误登出。`captureTicketCookie` 的只写不清刷新（`nuwaxBridgeHandlers.ts:487-489`）目前唯一挂点是 `getToken`，覆盖面偏窄

## 5. 图 4 · 现状：六类逃逸面（全部落在图 2 的 C 泳道）

```
webview(网关 origin)
 ├──① 外链菜单/微应用独立窗
 │     native:openWindow 直接 loadURL(业务域绝对URL)
 │     新窗无网关上下文, 归一钩子拦不到 → 整窗失登
 ├──② 收银台
 │     location.href = cashierUrl(支付外部域)
 │     → orderId 会话自理, 无登录态需求(保持现状)
 ├──③ 结算回跳页轮询
 │     payment-settlement.html 在 127.0.0.1 上
 │     硬编码直连 testagent 域(credentials:include) → 失登/跨域
 ├──④ 4011 / 登录 redirect
 │     window.location.href = 后端下发绝对URL → 整页跳出网关
 ├──⑤ 微应用页内绝对 URL(/instant-message /repo)
 │     前缀清单外 → 被 127.0.0.1 本地 dist SPA 兜底吃掉(404/回首页)
 └──⑥ 图片/文件资源 URL(img 标签/预览/下载)
       ⑥a 受保护 /api/f/ → Bearer fetch 转 blob 显示 ✅(现机制已通)
       ⑥b 业务域非 /api 前缀 → 归一进网关后被 dist 吃 ❌(同⑤机理)
       ⑥c OSS/CDN 公开域 → 不归一直连 ✅(无需登录态)
```

引文对照：

- ①菜单 NewTab + http(s) → `hostBridge.native.openWindow`（`nuwax/src/layouts/DynamicMenusLayout/utils.ts:207-244`）；壳侧直接 `win.loadURL(target.href)`（`nuwaxBridgeHandlers.ts:742-761`），独立窗用同一桥 preload（:749-757）故可走 `auth.getToken` 回退链自举 token，但**新窗首个文档加载本身在业务域**，无网关归一（绝对 URL 归一钩子仅对「发起页 origin=网关 origin」的 guest 请求生效，`index.ts:335-385`——新窗发起页就是业务域，条件不成立）
- ②收银台：`useSubscriptionPurchase.ts:55-74` 拿 `cashierUrl` 后 `window.location.href` 整页跳；returnUrl 按当前 origin 拼 `/static/payment-settlement.html`（:86-99）——回跳页挂在发起 origin，壳侧配套是 webviewNav 真值通道（bug2432，`nuwaxBridgeHandlers.ts:941-1000`）而非登录态
- ③结算回跳页轮询 `/api/bill/order/settlement-status`：dist 产物在 127.0.0.1 上时硬编码 `https://testagent.xspaceagi.com` 且 `credentials:'include'`（`nuwax/public/static/payment-settlement.html:217-244`，仅 dev/小程序形态才附 Bearer）——回环 origin 跨域带 cookie，测试域之外的环境直接失登
- ④4011：`common.ts:175-181` / `userService.ts:100-103` `window.location.href = 后端下发URL`；登录后 redirect 含 `://` 同样整页跳出（`Login/index.tsx:176-177`）
- ⑤微应用：iframe src 为后端下发绝对 URL；归一钩子按前缀清单反代（`DEFAULT_BACKEND_PREFIXES=["/api","/computer","/devcomputer"]`，`gateway.ts:373`；垫片 `MICROAPP_BACKEND_PREFIXES=["/instant-message","/repo"]`，`index.ts:36-47`，env 旋钮 `NUWAX_GATEWAY_EXTRA_BACKEND_PREFIXES` :50-57）——**清单制天然滞后**：微应用页内新路径不在清单 → 落到本地 dist 的 SPA 回退（`gateway.ts:364-369` 末段无扩展名回退 index.html）→ 404 或回首页。用户本轮确认的实际现象即此类（消息/资料库菜单页面下的内部请求）
- 前端已有的同源化先例（⑤的页面侧半解）：`%siteUrl%` 占位符替换为 `window.location.origin`（`utils.ts:8-27`）；repo iframe 主动用当前 origin 拼（`AppProjectDetail/index.tsx:947-962`，注释「仓库页面会读取父窗口的嵌入配置，必须与父页面保持同源」）
- **⑥ 图片/文件资源 URL**——「img 标签 + 后端地址转真实图片地址」的标准实现是 `useAuthProtectedImageSrc`（`nuwax/src/hooks/useAuthProtectedImageSrc.ts:17-78`）：`isAuthProtectedFileUrl` 判 `/api/f/`（`utils/authProtectedFileUrl.ts:3`）→ 受保护地址 Bearer fetch 转 blob object URL 再喂 img；公开地址原样进 src。消费面广：技能/连接器/专家/项目图标（`SkillIcon`/`ConnectorIcon`/`ExpertIcon`/`ChatInputUnified:138,492`/`ExpertSummonCard:283`，字段族 `fileProxyUrl`——`types/interfaces/skill.ts:20`、`appDev.ts:687`，`common.ts:635` 注释「可为受保护地址」）；下载走 `openRemoteFileUrl`（`authProtectedFileUrl.ts:63-86`：受保护 Bearer 拉取 blob 触发下载，公开直接 `window.open`）；预览走 FilePreview/ImageViewer **裸用 src、自身无鉴权处理**（`ExternalFilePreview/index.tsx:90` `src={fileProxyUrl}` 直传）

### ⑥ 的命运矩阵（gateway 形态）

| URL 形态 | 消费方式 | direct 形态 | gateway 形态 | 机理 |
|---|---|---|---|---|
| `/api/f/...`（相对或业务域绝对） | hook Bearer fetch→blob | ✅ 同源+Bearer | ✅ **现机制已通**：绝对 URL 被归一钩子拽回网关（路径在 /api 前缀内）→ fetch 自带 Bearer | 归一+前缀+token 三重保障 |
| `/api/f/...` | FilePreview/img/iframe 裸 src（带不了头） | ✅ 同源 cookie | ✅ **现机制已通**：同源落网关（相对）/归一（绝对）→ /api 前缀反代 → 网关缺省代注 Bearer | 网关代注兜住无头通道 |
| 业务域绝对 URL、路径**非** /api 等前缀（如 /files /static 资产） | img src / window.open / iframe | ✅ 同源直连 | ❌ **断**：归一钩子拽回网关 → 前缀清单外 → dist 静态 404（带扩展名）或 SPA 回退（无扩展名）——与⑤同根 | 清单制天然滞后 |
| OSS/CDN 域（公开或签名 query） | 任意 | ✅ | ✅ 不归一直连，无需登录态 | 非 serverHost host 不在归一范围 |
| OSS/CDN 域（需登录态） | 任意 | ❌ | ❌ | 与形态无关的既有缺口 |

注：⑥b 是否存在现实样本取决于后端资产 URL 契约（是否全部走 `/api/f/` 或 OSS）——列协调清单 #6；若全是，⑥b 为理论风险，host 命名空间收编（WS1）同样顺带覆盖。⑥a 在 WS1c 出口剥 ticket 后依旧成立：裸 src 场景从「cookie 转发+代注」变为纯代注，代注本就在。

## 6. 图 5 · 目标架构：三条泳道各归各位，双通道结构性消失

```
┌──────────────────────── Electron 壳 ────────────────────────┐
│                                                             │
│ ①⑤⑥b 收编进网关(改动: overlay 网关)                        │
│    命名空间路由: /__backend/<host>/<path> (免前缀冲突)         │
│    openWindow: loadURL 前重写 业务域URL → 网关命名空间 URL      │
│    归一钩子: 按 host 改写, 不再依赖前缀清单                     │
│                                                             │
│ 网关路径 = 纯 header (改动: gateway 出口)                      │
│    出口剥 ticket cookie ⭐                                   │
│    缺 Authorization 才代注(现有)                              │
│    → 图3 的「新Bearer+旧cookie」组合结构性不可达               │
│                                                             │
│ 未知逃逸兜底 (改动: 壳 session 钩子, x-client-type 同款挂点)   │
│    onBeforeSendHeaders: 目标=业务域 & 缺Auth                  │
│      → 补 Bearer (含导航/子资源/WS upgrade)                   │
│    兼修: gateway登录→关加速→直连形态 WS 无 cookie 的存量缺口    │
│                                                             │
│ cookie 策略: 页面 jar 不种 ticket                             │
│    ticket 只存: settings 键(reg feedstock, 用前刚刷新)         │
│              + 127.0.0.1 jar(登录自然落值, 出口剥离后不达后端)   │
│    captureTicketCookie 保留 = 后端续期行为观测点               │
│                                                             │
│ 续期: header-only 下 token=登录产生/4010失效/无续期(现状)       │
│    若后端未来下发新token: 网关拦Set-Cookie→settings镜像         │
│      →nuwax:authChanged 推送→前端刷 localStorage(可选WS3)      │
└─────────────────────────────────────────────────────────────┘
```

### 方案对比（决策轴：后端 cookie 优先约束）

| 方案 | 内容 | 对「新 Bearer+旧 cookie」的处理 | 结论 |
|---|---|---|---|
| A 网关吞并强化 | 命名空间路由 `/__backend/<host>/<path>` + 归一钩子按 host 改写 + openWindow 重写 | 逃逸面①⑤⑥b 不再依赖前缀清单直连业务域，组合在网关路径被出口剥离兜住 | **采纳（主）** |
| A' 网关出口剥 ticket | `buildProxyHeaders` 转发前从 `cookie` 头剥掉 `ticket`（其余 cookie 保留） | 组合在 gateway 路径结构性不可达；直连 web 纯 Bearer 可行性已实证 | **采纳（必做）** |
| C 会话级 Bearer 注入 | defaultSession `onBeforeSendHeaders` 对目标=业务域且缺 Authorization 的请求补 Bearer（含导航/WS upgrade；登录接口豁免） | 兜 A 覆盖不到的未知逃逸；兼修「gateway 登录→关加速→直连 WS 无 cookie」存量缺口（WS 按当前 origin 拼装、无 token 通道，切直连后同源 cookie 不存在） | **采纳（兜底）** |
| B 业务域种 cookie 地板 | 登录/刷新时向业务域 jar 种 HttpOnly ticket（社区版 sessionHandlers 先例） | 靠枚举同步点维持种子新鲜：重登、后端滑动续期、跨形态切换任一遗漏即复现图 3 必炸场景 | **撤销**（正是用户指出的风险形态；且 C 已覆盖其全部收益面） |

C 的已知注意项：跨域请求被注入 Authorization 后触发 CORS preflight，需后端 ACAO 放行回环 origin（协调清单 #2）；命名空间收编后绝大多数请求回到同源，不触发 preflight，该项不阻塞壳侧实施。

### 生命周期对照（收编后）

| 事件 | token（header 通道） | ticket（受控镜像） |
|---|---|---|
| 登录 | localStorage + 三候选 settings 键双写；网关路径缺省代注源同键空间 | Set-Cookie 落登录 origin jar + `captureTicketCookie` 双写 settings 键 |
| 形态切换（加速开关） | 回退链迁移 + 回写，免重登（现有） | 不动（127.0.0.1 jar 留值无害：出口剥离后不抵后端） |
| 4010 / 401 / 登出 | 全候选键清 + `auth:clear` + 回登录页（现有三档清理语义不变） | 同批清（`clearSiteStorage` 含 cookies，现有） |
| 换域 configureServerHost | 全清含 savedKey + 逐 origin 清 storage + 硬重载（现有） | 同左（现有） |
| 后端续期（若引入） | 网关拦截 Set-Cookie → settings 镜像 → `nuwax:authChanged` 推送 → 前端刷 localStorage（新增，前端可选 WS3） | 同一拦截点更新镜像；`captureTicketCookie` 观测点保留 |

## 7. 后端协调清单（本批不实施，随方案沟通）

1. **ticket 轮换/续期语义**：会话中途是否重发 Set-Cookie？ticket 值是否恒≡登录 token？——决定续期矩阵哪一行成真、reg 观测点（`captureTicketCookie` 刷新挂点）是否需要前移到网关拦截
2. **ACAO 放行回环 origin**：C 兜底路径跨域注入 Authorization 触发 preflight，需后端对 `http://127.0.0.1:46800` 放行（同源收编后仅兜底路径受影响）
3. **settlement-status 鉴权模型**：确认 Bearer 可用（payment-settlement 的 dev/小程序分支已附 Bearer，推断可行；修正后主路径改走当前 origin 相对路径）
4. **cashierUrl 域形态**：test 环境收银台是否落在配置域（当前按外部支付域设计，orderId 会话自理；若落在配置域则自动被命名空间收编，需确认 returnUrl 构造）
5. **4011 下发 URL 形态契约**：能否约定为相对路径/路由名，或至少保证与登录域同 host（前端同源映射的边界条件）
6. **图片/文件资产 URL 契约**：后端下发的图标/图片/文件地址（`fileProxyUrl` 族）是否全部为 `/api/f/` 受保护路径或 OSS 签名域？是否存在业务域非 /api 前缀的资产路径（⑥b 现实样本）？——决定 ⑥b 是理论风险还是现网缺陷，以及 dist 内置静态资产是否需要同步网关路由豁免

## 8. 风险与开放问题

- **Electron webRequest 单 listener 约束**：defaultSession 的 `onBeforeSendHeaders` 同一 session 只有一个生效 listener，C 不能另挂一个（会顶掉 main.ts:762 的 x-client-type 注入）——实施取「overlay 整体替换 listener（自含复制 x-client-type 逻辑）」或「基座中立 seam」，决策与代价见实施计划 WS2
- **命名空间路由安全**：`/__backend/<host>/` 必须按 host 白名单（业务域 host）校验，防本地网关沦为开放代理
- **C 注入与重登交互**：登录/验证码接口须豁免注入（旧 token 附在重登请求上虽大概率无害，但避免后端「已认证」短路干扰凭据判定）
- **openWindow 重写范围**：仅重写 host=业务域的 URL；squareBannerLinkUrl 等真外站保持直开
- 微应用 qiankun 化后（`index.ts:42-46` 注释已预告），前缀垫片与命名空间路由一并复审回收
