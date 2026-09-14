# reg 附登录会话 ticket cookie（全新设备首登 4000 修复）· 计划

日期：2026-09-14 ｜ 落点：**纯 overlay**（commercialAuth.ts + nuwaxBridgeHandlers.ts，不动基座）｜ 关联：prerelease-v1.0.4 提测反馈

## 问题

新装客户端首登报「配置同步失败 / 动态认证码或密码不能为空」= 后端 `/api/sandbox/config/reg` 4000。后端 reg 把「动态认证码（savedKey）或密码」当鉴权主体，Bearer 不算数；savedKey 只能由 reg 成功发放——全新设备鸡生蛋死局（09-12/09-14 curl 两轮实证）。

## 方案（产品拍板：ticket cookie 同步进壳）

web 登录会话的 `ticket` cookie（服务端 Set-Cookie）同步到壳侧持久化，reg 请求附 `Cookie: ticket=…`——后端认登录会话放行首次设备注册。

- **捕获**（桥）：`session.cookies.get`（主进程可读 HttpOnly/内存态 session cookie）。候选域 = nuwaxTokenScopes 全集（直连=业务域、gateway=Set-Cookie 规整后落回环网关域、dev 直连=本地前端域），探测到值即**双写全部候选键**（与 token 同族的 `nuwax.ticket.<origin>` 分键）。
- **时机**：`auth:persistToken`（登录成功，await 捕获后再起 reg 链；找不到则清——登录时刻即事实）；`auth:getToken`（后台刷新，**只写不清**——重启后内存 cookie 消失，不得误清持久值）。
- **清理**：auth:clear / token 失效 / 换域——与 token 键同点位清 ticket 键。
- **消费**（reg）：`readTicketCookieValue(候选域)` → headers 附 `Cookie: ticket=…`（有 savedKey 时也附带，无害更稳）。

## 验证

1. 单测：ticket 存在时 reg fetch headers 含 Cookie；无 ticket 不附带；读写助手候选序回读。
2. 门禁：test:commercial + check:pin（overlay-only，不动基座）。
3. dev 实证：登录/重启链路 ticket 落库 + reg 请求带 Cookie + 观察后端 0000/4000（若仍 4000 = 后端侧未就绪，如实回报）。

## 风险

- ticket 为内存态 session cookie：app 重启后靠持久化的 settings 值（getToken 只刷新不清除的设计保证不误删）。
- 后端是否真接受 Cookie 形式待 dev 实证；若需裸 header 形式，改一行 headers。
