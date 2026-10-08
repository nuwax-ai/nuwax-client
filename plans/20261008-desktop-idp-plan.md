# 本期桌面三方登录配套

用户 10.08 已确认 C2 本期支持三方登录。前端规格为 nuwax 仓库 `specs/release0930-desktop-idp.md`，复用现有 WebView 与 auth.getContext/beginLogin/syncSession，无新增 IPC。

本仓只补网关归一策略：受信页面的业务域顶层 `/api/auth/idp/`、`/api/user/identity/bind/`、`/auth/` 导航不改为 loopback，保证授权 state Cookie 与 IdP 登记的业务域回调同源。保留 iframe/XHR 既有归一与票据来源门禁。前端在业务域回调确认 Cookie 后返回本地源；其他 origin 不获桥和业务票据。

独立分支 `codex/desktop-idp-20261008` 从客户端提交 `3b990c1c3e964e8d59a39a0f14e5bf73ce561bf2` 起步，主区壳 WIP 保留。定向纯策略测试及临时 Electron profile 验证后，再交付源码/dist pin 与安装包；不把前端测试部署当作客户端已发布。
