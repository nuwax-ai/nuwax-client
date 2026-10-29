# 浏览器扩展能力

`browser` 静态特性仅面向 nuwax，默认启用，`features.browser.enabled` 覆盖；首次打开才创建窗口。基础层分类普通链接，读取 `nuwax.linkOpenMode`（`in-app` / `system`，缺省 `in-app`）。关闭或注册失败回退系统浏览器，不维护第二套普通外链窗口。

浏览器模块自管窗口、页面和窄 IPC；宿主通过公开入口提供页面会话、导航/下载/凭据策略，特性不引用宿主数据库或鉴权实现。工具栏为本地独立页面和临时 session，远程内容为共享网页 session 的 WebContentsView；页面不能操作工具栏 IPC。

普通外链入口覆盖 window.open 与 native.openWindow。新前端包装器将跨域网页调用标为 `{ purpose: 'page' }`，支付入口标为 `{ purpose: 'payment' }`，相对路径与同源业务调用保留旧形状。旧前端省略用途时保留原有专用窗口语义，避免用户选择系统浏览器后旧支付页被误分流；支付子窗口继承专用用途。站内业务、POST、受保护附件不按普通外链分流。已有页面中的同窗导航不受默认打开设置影响。

功能和交互见已确认 intent。查找、复制、缩放、打印只操作所属网页；缩放沿用 Chromium 同站点规则。关闭网页前尊重 beforeunload，退出/换域撤销相关窗口。所有创建、监听、IPC 随特性释放。
