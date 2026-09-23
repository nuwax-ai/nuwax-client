# 规格：loopback 登录态 header 通道与资源路由

- 日期：2026-09-22；对应 intent：`plans/20260922-loopback-login-sync-intent.md`。
- 状态：代码评审后修订，用户已授权实施；自动验证、真实环境验收分别记录。
- 基线：外层 `4562cdb4`、基座 `f59f1bbe`、前端 `df987b3b9`；分支 `codex/loopback-login-sync`。

## 1. 评审修正

1. 网关剥 ticket 不覆盖 direct，两条出口分别治理。
2. defaultSession 内有外站，不可直接信任；host-only 会遗漏 scheme/port。
3. 文档加 namespace 会改变 SPA pathname；只改业务域绝对 URL 不覆盖微应用同源相对资源。
4. 分别现读 token/ticket 不保证同批，异步 cookie 捕获必须校验代次。
5. 前端没有现成的业务域常量，需由受信桥提供。
6. 代码不能证明后端无静默续期，不能把生产 Web 的 Bearer 使用泛化为所有端点已验收。

## 2. 鉴权契约

商业逻辑全部经 overlay 交付，前端在独立检出修改；基座无商业提交。

| 请求 | 规则 |
|---|---|
| gateway HTTP/WS | 出口剥所有 ticket，保留其他 cookie；仅主进程确认的受信页面在非公共接口缺 Auth 时可补当前 Bearer。外站直接访问网关不得借用本机 token |
| 受信 renderer 直连当前业务 origin | 无论是否已有 Auth 均剥 ticket；缺 Auth 时补当前 Bearer |
| 登录公共路径 | 不代注旧 Bearer，不依赖旧 ticket |
| 外站发起/非业务 origin | 不自动授予用户 token；HTTPS 不降级到 HTTP |
| 主进程设备注册 | 保留自身显式、配对的 ticket；不按 URL 给 renderer 豁免 |

公共路径：`/api/user/passwordLogin`、`/api/user/codeLogin`、`/api/user/code/send`。头名不区分大小写；cookie 名 ticket 精确匹配。

一个 `onBeforeSendHeaders` listener 接管商业桥挂点，保留 x-client-type 的现有 HTTP(S) 行为，Bearer filter 显式覆盖 HTTP(S)/WS(S)。匹配完整 origin，WS 只做 ws/http、wss/https 等价映射。可信性结合 requesting frame 与顶层文档来源判断；受信页面访问网关时由主进程附临时 capability，网关仅凭此 capability 代补存储的 Bearer。无 renderer webContents 的主进程请求保留自己的显式鉴权。

## 3. ticket 与生命周期

不向页面 jar 主动种 ticket。登录响应自然落值允许保留，但普通出口不转发。捕获时固定 generation/businessOrigin/token；跨 await 复核，提交前再次检查。

仅接受实际捕获且与当前 token 匹配的 ticket，当前契约以值相等判定，不把 token 人工合成为 ticket、不取旧 jar 首个非空值。后端若非恒等，须补有版本绑定的契约后扩展，不能静默放宽。重启后 jar 空但持久镜像与当前 token 匹配仍可注册。

token 替换先撤销旧生命周期，再异步捕获与启动注册；保留 savedKey 的同账号规则。迟到过期响应仅在 signal 与当前会话有效时触发登出。

## 4. 网关路由

- 主 SPA 与已登记微应用文档保持 pathname/search/hash。
- 保留 `/api`、`/computer`、`/devcomputer`、`/instant-message`、`/repo` 与现有受控扩展前缀。
- `/__backend/<host>/<path>` 仅允许当前配置后端，不增加多域 token 分发；先于静态/SPA fallback。HTTP/WS 去前缀后转发，query 保真。
- 校验 host 段及完整目标，拒绝 userinfo、反斜杠、非法编码和端口绕过；不能成为任意目标代理。
- 业务域绝对子资源、已登记微应用 frame 的 gateway 根相对/目录相对资源归上游；主 SPA 的同名静态资源仍本地加载。
- 同后端资源重定向和 Referer 保持上游路径语义；外站重定向不继承自动注入的业务凭据。
- 新微应用文档根仍须登记，不承诺透明代理任意远程 SPA。CSS/module/资源相对引用须作为实测项，不能只测 xhr。

## 5. 桥与前端

`auth:getContext` → `NuwaClawBridge.auth.getContext()` → `hostBridge.auth.getContext()`：

```ts
type AuthContext = {
  businessOrigin: string;
  gatewayOrigin: string | null;
  loadMode: 'gateway' | 'direct';
};
```

只响应受信来源；旧宿主失败降级 null。密码登录 redirect、验证码登录 redirect、common 4011、userService 4011 共四处使用统一助手。仅 gateway 且 URL 完整 origin 等于 businessOrigin 时映射 gatewayOrigin，保留 path/query/hash；web/direct/外站保留原行为。

结算始终同源请求 settlement-status；有 localStorage token 即附 Bearer，保留小程序 query/hash 回退。HTTP 401 或业务 4010/4011 立即停轮询提示重新登录，不误报支付失败。

## 6. 异常、验收与未决契约

非法 namespace 403；上游不可达 502；迟到捕获/注册丢弃；无 token 不制造凭据；旧宿主缺桥不阻塞原导航。

| 编号 | 必须覆盖 |
|---|---|
| V1 | gateway/direct 独立窗首文档、SPA 二级路由、微应用路径 |
| V2 | 微应用绝对/根相对/目录相对资源、同名 dist 静态、资源 302、未知文档根边界 |
| V3 | 结算同源、有 token 无 cookie、401/4010/4011 停轮询；真实支付另验 |
| V4 | 四个导航入口、企业域、query/hash、外站、旧宿主 |
| V5 | HTTP/WS、gateway→direct→gateway、无 cookie、已有 Authorization |
| V6 | 两出口均无 ticket、其他 cookie 保留、主进程注册例外 |
| V7 | 新 token + 两 jar 旧 ticket、公共登录路径、同账号/换账号 |
| V8 | 捕获/注册中登出换域再次登录、迟到 expired、重启持久镜像 |
| V9 | blob 图标、裸 src/iframe、非 /api 资源、公开 OSS |
| V10 | 外站窗口/iframe、HTTP 降级、不同端口、WS(S) 注入边界 |

网关用真实 HTTP/WS 上游夹具；Electron 运行时用临时 profile 与虚构 token。自动化、macOS/Windows 安装包、真实后端分别记录。

后端 Bearer-only、ticket 轮换、结算/文件/WS 契约是上线前验证项。CORS/preflight 需按请求形态与 Electron 40 拦截阶段实测，不因后注入 Authorization 就断言一定新增 OPTIONS；也不能仅放行固定 46800（网关会回退随机端口）。

## 7. 否决项与依据

否决：全部文档 namespace、回收微应用前缀、业务域主动种 ticket、仅治理网关、复制 HTTP filter 即宣称 WS 覆盖、复用旧工作树测试数字宣称本批通过。

[Electron 40 WebRequest 官方文档](https://github.com/electron/electron/blob/v40.0.0/docs/api/web-request.md)规定每事件最后一个 listener 生效，提供 frame/webContents/webSocket resourceType。实现不依赖后续版本新增的 initiatorOrigin。
