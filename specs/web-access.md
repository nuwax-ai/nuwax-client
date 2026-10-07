# 规格：web-access

- 对应 intent：`plans/20261007-web-access-intent.md`
- 状态：按用户已明确访问方向实施；凭据边界沿用现有契约。

## 需求基线

允许任意 HTTP/HTTPS 网站正常加载；业务域集合只决定登录和宿主能力，不决定是否可以访问或是否必须新建临时会话。

## 方案设计

### 架构落点

- 商业 overlay 的 webviewPolicy 移除跨域 HTTP 导航搬迁和初始外域会话替换。
- 商业页面窗口共享 defaultSession；轻量 preload 可在正常导航时重新执行，但只对实际受信文档暴露桥。主宿主的完整 preload 不得进入网页。
- 业务新窗口来源分类不再因顶层与受信 iframe 位于不同镜像源而失配。GET 业务文档正常使用登录；外域来源 POST/API 请求继续校验，不能借此获得 API 鉴权。
- sessionAuthInjection 继续过滤异域 ticket 和私有 gateway header，按实际 frame 校验 XHR/WebSocket；补首次文档和跨域返回业务页的浏览器式导航覆盖。
- native.openWindow 与 window.open 使用相同会话模型，保留标题栏、关闭确认和下载窗口清理。
- 微应用更新由显式升级入口执行，生产构建校验并消费 gitlink 与 adapter.pin，不自动追远端。

### 数据与契约

无新增存储或 IPC。业务集合继续来自 businessBridgeOrigins；精确 origin 不扩张。README、测试和验收夹具同步新会话行为。

Cookie 按主机/父域记录，无法区分端口。网关同主机的其他 origin 无法证明 ticket 归属，因此保守移除所有 ticket 命名 Cookie；Cookie 来源查询失败时同样过滤 ticket。其他 Cookie 保留，普通独立第三方网站的自有 ticket 可正常使用。来源记录在单个会话策略内维护，保留轮换和旧业务域的票据信息，避免重定向泄漏。

### 平台矩阵

| 场景 | macOS / Windows / Linux |
| --- | --- |
| 任意 HTTP(S) 顶层跳转 | 原窗口正常导航 |
| 第三方新窗口 | 共享浏览器会话，无业务桥/票据 |
| 业务 GET 新窗口和返回导航 | 使用业务登录；桥按实际文档校验 |
| 业务 iframe | 保留现有嵌入头处理与实际 frame 鉴权 |
| 非网页协议 | 保留原阻止策略 |

## 异常与失败场景

未知/销毁 frame 不授权 API；带 URL 凭据的源不视为业务源；下载和加载失败不留空窗口。换域继续关闭捕获旧业务源的窗口并失效登录代次。

## 测试计划

- 修改导航、弹窗、native.openWindow、sessionAuthInjection 与 preload 的相关测试。
- 真实 Electron 临时 profile：站内 noreferrer 链接含第三方 iframe、业务镜像 iframe、新窗口/原窗口跨域往返、第三方 Cookie 保留、外域请求无 ticket/bridge、POST 和附件行为。
- 商业完整质量门；社区在隔离副本执行 base:test；前端冻结候选构建。

## 备选方案

继续一次性第三方窗口会话不满足普通浏览器导航体验；把所有域加入业务集合会扩大票据与 IPC 能力，超出本次需求。
